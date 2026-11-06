export type ObjectValue = Record<string, unknown>;
export type RateDecision =
  | { action: "none" }
  | { action: "cooldown"; delayMs: number; reason: string; slowDown: boolean }
  | { action: "pause"; reason: string };
export interface DispatchSnapshot {
  state: "ready" | "spacing" | "cooldown" | "paused" | "closed";
  waitMs: number;
  reason: string | null;
  effectiveStartIntervalMs: number;
  maxRequestsPerMinute: number | null;
}
export interface Fixture {
  name?: string;
  events: ObjectValue[];
  expectedText?: string;
}
export type UpstreamKind =
  "offline" | "chatgpt-subscription" | "openai-api-key";
export interface Config {
  upstream: UpstreamKind;
  model: string | null;
  authPath: string;
  port: number;
  concurrency: number;
  maxRequestsPerMinute: number | null;
  fixturePath: string;
  queueCapacity: number;
  maxQueueWaitMs: number;
  minStartIntervalMs: number;
  upstreamTimeoutMs: number;
  maxRequests: number | null;
  stopAfterTokens: number | null;
  profile: "strict" | "lotus";
  reportPath: string;
  databasePath: string;
}
export interface LedgerRecord {
  id: string;
  sequence: number;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "unknown"
    | "cancelled"
    | "expired"
    | "rejected";
  receivedAt: string;
  startedAt?: string;
  finishedAt?: string;
  inferenceDispatched?: boolean;
  dispatchedAt?: string;
  headersAt?: string;
  firstTextAt?: string;
  terminalAt?: string;
  endReason?: string;
  error?: string;
  requestHash: string;
  model?: string;
  outputFormat?: string;
  transformations: { parameter: string; requested: unknown; effect: string }[];
  rawUsage?: ObjectValue;
  rateLimit?: {
    observedAt: string;
    headers: Record<string, string>;
    decision: RateDecision;
  };
  upstreamHttp?: { status: number; requestId?: string; retryAfter?: string };
  upstreamError?: ObjectValue;
  upstreamIncompleteDetails?: ObjectValue;
  usage?: ObjectValue;
  usageCompleteness?: "complete" | "partial" | "missing";
}
export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface HistoryRecord extends LedgerRecord {
  cursor: number;
  runId: string;
  historical: boolean;
  lastKnownState: boolean;
}
export interface RequestPage {
  items: HistoryRecord[];
  nextCursor: number | null;
}
export interface StatusSnapshot {
  mode:
    | "offline-only"
    | "subscription-probe"
    | "chatgpt-subscription"
    | "openai-api-key";
  upstream?: UpstreamKind;
  authorization?: { state: string };
  pauseReason?: string;
  dispatch?: DispatchSnapshot;
  upstreamLimits?: { observedAt: string; headers: Record<string, string> };
  accountBalance?: "unknown";
  actualCost?: "unknown";
  asOf: string;
  runId: string;
  startedAt: string;
  queue: {
    concurrency: number;
    running: number;
    preparing?: number;
    inFlight?: number;
    waiting: number;
    capacity: number;
    paused: boolean;
    closed: boolean;
    minStartIntervalMs: number;
    maxQueueWaitMs: number;
    upstreamTimeoutMs: number;
  };
  budget: {
    requests: { used: number; limit: number | null; remaining: number | null };
    tokens: { used: number; limit: number | null; remaining: number | null };
  };
  usage: ReturnType<typeof import("./usage.ts").summarizeUsage>;
  storage: { healthy: boolean; path: string; error?: string };
}
