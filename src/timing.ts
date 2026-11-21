import type { LedgerRecord, RequestTimingMetrics } from "./types.ts";
import { object } from "./compatibility.ts";

const monotonicNow = () => performance.now();

/** Clock samples stay private until the existing final ledger write. */
export class RequestTiming {
  private readonly accepted: number;
  private sentAt?: number;
  private sentWall?: number;
  private firstText?: number;
  private lastText?: number;
  private firstToolArguments?: number;
  private textChunks = 0;
  private upstreamDone?: number;
  private toolTurn = false;

  private readonly now: () => number;

  constructor(now = monotonicNow) {
    this.now = now;
    this.accepted = now();
  }

  sent(record: LedgerRecord): void {
    this.sentAt = this.now();
    this.sentWall = Date.now();
    record.dispatchedAt = new Date(this.sentWall).toISOString();
  }

  text(): void {
    const time = this.now();
    this.firstText ??= time;
    this.lastText = time;
    this.textChunks++;
  }

  toolArguments(): void {
    this.firstToolArguments ??= this.now();
  }

  completedUpstream(): void {
    this.upstreamDone = this.now();
  }

  markToolTurn(): void {
    this.toolTurn = true;
  }

  finish(record: LedgerRecord): void {
    const timing: RequestTimingMetrics = {
      gatewayMs: this.now() - this.accepted,
      tpotUnavailable: "request_failed",
    };
    record.timing = timing;
    const sentAt = this.sentAt,
      sentWall = this.sentWall;
    if (sentAt === undefined || sentWall === undefined) return;
    const wallTime = (time: number) =>
      new Date(sentWall + time - sentAt).toISOString();
    timing.preSendMs = sentAt - this.accepted;
    if (this.firstText !== undefined && this.lastText !== undefined) {
      timing.ttftMs = this.firstText - sentAt;
      record.firstTextAt = wallTime(this.firstText);
      record.lastTextAt = wallTime(this.lastText);
    }
    if (this.firstToolArguments !== undefined) {
      timing.firstToolArgumentsMs = this.firstToolArguments - sentAt;
      record.firstToolArgumentsAt = wallTime(this.firstToolArguments);
    }
    if (record.status !== "completed" || this.upstreamDone === undefined)
      return;
    timing.upstreamMs = this.upstreamDone - sentAt;
    if (this.toolTurn) timing.tpotUnavailable = "tool_turn";
    else if (this.firstText === undefined || this.lastText === undefined)
      timing.tpotUnavailable = "no_text";
    else if (this.textChunks < 2) timing.tpotUnavailable = "single_chunk";
    else {
      const output = record.usage?.completion_tokens;
      const details = record.usage?.completion_tokens_details;
      const reasoning = object(details) ? details.reasoning_tokens : undefined;
      if (typeof output !== "number" || typeof reasoning !== "number")
        timing.tpotUnavailable = "usage_detail_missing";
      else if (output - reasoning <= 1)
        timing.tpotUnavailable = "too_few_tokens";
      else {
        timing.tpotMs =
          (this.lastText - this.firstText) / (output - reasoning - 1);
        delete timing.tpotUnavailable;
      }
    }
  }
}
