import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerRecord, HistoryRecord, RequestPage } from "./types.ts";
/** The gateway is the sole owner of this connection; monitoring queries are read-only. */
export class History {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 1000 });
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, metadata TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS requests (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id), record_json TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS requests_run_cursor ON requests(run_id,cursor);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  start(runId: string, startedAt: string, metadata: unknown): void {
    this.db
      .prepare("INSERT INTO runs(id,started_at,metadata) VALUES(?,?,?)")
      .run(runId, startedAt, JSON.stringify(metadata));
  }
  save(runId: string, record: LedgerRecord): void {
    this.db
      .prepare(
        `INSERT INTO requests(id,run_id,record_json) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json`,
      )
      .run(record.id, runId, JSON.stringify(record));
  }
  private decode(
    row: Record<string, unknown>,
    currentRun: string,
  ): HistoryRecord {
    return {
      ...JSON.parse(String(row.record_json)),
      cursor: Number(row.cursor),
      runId: String(row.run_id),
      historical: row.run_id !== currentRun,
      lastKnownState: row.run_id !== currentRun,
    };
  }
  list(
    currentRun: string,
    options: { runId?: string; before?: number; limit: number },
  ): RequestPage {
    const rows = this.db
      .prepare(
        `SELECT cursor,run_id,record_json FROM requests
      WHERE (? IS NULL OR run_id=?) AND (? IS NULL OR cursor<?)
      ORDER BY cursor DESC LIMIT ?`,
      )
      .all(
        options.runId ?? null,
        options.runId ?? null,
        options.before ?? null,
        options.before ?? null,
        options.limit + 1,
      );
    const more = rows.length > options.limit;
    const items = rows
      .slice(0, options.limit)
      .map((row) => this.decode(row, currentRun));
    return { items, nextCursor: more ? items.at(-1)!.cursor : null };
  }
  get(currentRun: string, id: string): HistoryRecord | undefined {
    const row = this.db
      .prepare("SELECT cursor,run_id,record_json FROM requests WHERE id=?")
      .get(id);
    return row ? this.decode(row, currentRun) : undefined;
  }
  finish(runId: string): void {
    this.db
      .prepare("UPDATE runs SET ended_at=? WHERE id=?")
      .run(new Date().toISOString(), runId);
  }
  close(): void {
    this.db.close();
  }
}
