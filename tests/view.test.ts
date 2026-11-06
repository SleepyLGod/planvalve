import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { createGateway } from "../src/gateway.ts";
import { render, initialView, keyAction, cell } from "../src/view.ts";
import type { HistoryRecord } from "../src/types.ts";
const request: HistoryRecord = {
  id: "example-id",
  cursor: 4,
  runId: "old-run",
  sequence: 1,
  status: "unknown",
  receivedAt: "2026-11-06T00:00:00.000Z",
  startedAt: "2026-11-06T00:00:00.000Z",
  finishedAt: "2026-11-06T00:00:01.000Z",
  requestHash: "hash",
  historical: true,
  lastKnownState: true,
  transformations: [
    {
      parameter: "temperature",
      requested: "\x1b[2Jsecret\nline",
      effect: "omitted",
    },
  ],
  rawUsage: { input_tokens: 58, output_tokens: 13, total_tokens: 71 },
  usage: { prompt_tokens: 58, completion_tokens: 13, total_tokens: 71 },
};
test("scheduling overview translates actual in-flight counts and cooldown separately from configured limits", async () => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  try {
    const status = gateway.status();
    status.queue.concurrency = 4;
    status.queue.running = 2;
    status.queue.preparing = 1;
    status.queue.inFlight = 1;
    status.dispatch = {
      state: "cooldown",
      waitMs: 1200,
      reason: "rate_limit_exceeded",
      effectiveStartIntervalMs: 6000,
      maxRequestsPerMinute: 20,
    };
    const data = { status, page: { items: [], nextCursor: null } };
    const en = render(data, initialView(), {
      width: 110,
      color: false,
      lang: "en",
    });
    assert.match(en, /In flight 1/);
    assert.match(en, /Preparing 1/);
    assert.match(en, /Cooldown/);
    assert.match(en, /6000/);
    assert.match(en, /1200/);
    const zh = render(data, initialView(), {
      width: 110,
      color: false,
      lang: "zh",
    });
    assert.match(zh, /上游在途 1/);
    assert.match(zh, /准备中 1/);
    assert.match(zh, /上游冷却/);
    delete status.dispatch;
    delete status.queue.inFlight;
    delete status.queue.preparing;
    assert.doesNotThrow(() =>
      render(data, initialView(), { width: 35, height: 15, color: false }),
    );
  } finally {
    await gateway.close();
  }
});
test("terminal handles narrow windows, unknown details and metadata controls", async () => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  try {
    const status = gateway.status();
    status.usage.cached.unknownRequests = 1;
    const data = { status, page: { items: [request], nextCursor: null } };
    const state = initialView();
    const text = render(data, state, { width: 100, height: 24, color: false });
    assert.match(text, /离线模拟/);
    assert.match(text, /未知/);
    assert(!text.includes("\x1b"));
    const narrow = render(data, state, { width: 30, height: 12, color: false });
    assert(narrow.split("\n").length <= 12);
    assert(narrow.split("\n").every((line) => stringWidth(line) <= 30));
    state.detail = true;
    const detail = render(data, state, { width: 100, color: false });
    assert.match(detail, /最后已知状态/);
    assert.match(detail, /用量明细/);
    assert.doesNotMatch(detail, /rawUsage|requestHash/);
    state.raw = true;
    const raw = render(data, state, { width: 100, color: false });
    assert.match(raw, /rawUsage/);
    assert.match(raw, /input_tokens/);
    assert(!detail.includes("\x1b"));
    assert.match(raw, /secret/);
    assert(!raw.includes("secret\nline"));
    state.error = "connection lost";
    const disconnected = render(data, state, { width: 100, color: false });
    assert.match(disconnected, /连接中断/);
    assert.match(disconnected, /2026/);
    assert.match(disconnected, /rawUsage/);
  } finally {
    await gateway.close();
  }
});
test("keyboard navigation preserves page cursors and separates list/detail scrolling", () => {
  let state = initialView();
  const page = {
    items: [request, { ...request, id: "second" }],
    nextCursor: 4,
  };
  state = keyAction(state, "down", page).state;
  assert.equal(state.selected, 1);
  state = keyAction(state, "return", page).state;
  assert.equal(state.detail, true);
  state = keyAction(state, "r", page).state;
  assert.equal(state.raw, true);
  state = keyAction(state, "r", page).state;
  assert.equal(state.raw, false);
  state = keyAction(state, "pagedown", page).state;
  assert.equal(state.scroll, 10);
  assert.equal(state.selected, 1);
  state = keyAction(state, "escape", page).state;
  assert.equal(state.detail, false);
  let action = keyAction(state, "right", page);
  assert(action.refresh);
  state = action.state;
  assert.deepEqual(state.pageCursors, [undefined, 4]);
  assert.equal(keyAction(state, "right", page).refresh, false);
  state = keyAction(state, "left", page).state;
  assert.deepEqual(state.pageCursors, [undefined]);
  state = keyAction(state, "tab", page).state;
  assert.equal(state.scope, "all");
  assert.equal(state.selected, 0);
  assert.equal(keyAction(state, "q", page).quit, true);
});

test("Chinese table headers and values share display columns with wide glyphs and right-aligned numbers", async () => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  try {
    const item = {
      ...request,
      status: "completed" as const,
      historical: false,
      usage: { prompt_tokens: 58, completion_tokens: 13, total_tokens: 71 },
    };
    const output = render(
      { status: gateway.status(), page: { items: [item], nextCursor: null } },
      initialView(),
      { width: 109, height: 30, color: false },
    );
    assert.doesNotMatch(
      output,
      /OFFLINE|CONNECTED|REQUESTS|STATE|INPUT|OUTPUT|TOTAL|Input|Output|Queue|Budget|Cached|Reasoning|No requests|completed/,
    );
    const header = output
      .split("\n")
      .find((line) => line.includes("请求编号") && line.includes("输入"))!;
    const row = output
      .split("\n")
      .find((line) => line.includes("example-") && line.includes("已完成"))!;
    assert(header, "one shared table header");
    assert(row, "translated state in request row");
    const end = (line: string, word: string) =>
      stringWidth(line.slice(0, line.lastIndexOf(word) + word.length));
    for (const [title, value] of [
      ["输入", "58"],
      ["输出", "13"],
      ["总计", "71"],
    ])
      assert.equal(end(header, title!), end(row, value!));
    assert.equal(stringWidth(header), 109);
    assert.equal(stringWidth(row), 109);
    assert.match(output, /模型网关/);
    assert.match(output, /已连接/);
    assert.match(output, /本次用量/);
    assert.match(output, /运行状态/);
  } finally {
    await gateway.close();
  }
});

test("truncated values are marked rather than silently losing token digits", () => {
  const text = cell("1,234,567,890", 8, "right");
  assert.equal(stringWidth(text), 8);
  assert(text.endsWith("…"));
  assert.equal(cell("中文", 1), "…");
});
test("English mode translates both overview and details without changing token alignment", async () => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  try {
    const record = {
      ...request,
      historical: false,
      status: "completed" as const,
      transformations: [],
    };
    const data = {
      status: gateway.status(),
      page: { items: [record], nextCursor: null },
    };
    const state = initialView();
    const output = render(data, state, {
      width: 109,
      height: 30,
      color: false,
      lang: "en",
    } as any);
    assert.match(output, /Model gateway/);
    assert.match(output, /Input/);
    assert.match(output, /Completed/);
    assert.doesNotMatch(output, /[\u3400-\u9fff]/);
    const header = output
      .split("\n")
      .find((line) => line.includes("Request ID") && line.includes("Input"))!;
    const row = output
      .split("\n")
      .find((line) => line.includes("example-") && line.includes("Completed"))!;
    const end = (line: string, value: string) =>
      stringWidth(line.slice(0, line.lastIndexOf(value) + value.length));
    assert.equal(end(header, "Input"), end(row, "58"));
    assert.equal(end(header, "Total"), end(row, "71"));
    state.detail = true;
    const detail = render(data, state, {
      width: 109,
      color: false,
      lang: "en",
    } as any);
    assert.match(detail, /Usage details/);
    assert.match(detail, /Request information/);
    assert.doesNotMatch(detail, /[\u3400-\u9fff]/);
  } finally {
    await gateway.close();
  }
});
test("real upstream labels, auth, local budget and pause information are translated and never described as fixture usage", async () => {
  const gateway = createGateway({ port: 0, databasePath: ":memory:" });
  try {
    const status = {
      ...gateway.status(),
      mode: "openai-api-key" as const,
      upstream: "openai-api-key" as const,
      authorization: { state: "configured" },
      pauseReason: "rate_limit_exceeded",
    };
    const data = { status, page: { items: [], nextCursor: null } };
    const en = render(data, initialView(), {
      width: 120,
      color: false,
      lang: "en",
    });
    assert.match(en, /OpenAI API/);
    assert.match(en, /Configured/);
    assert.match(en, /rate_limit_exceeded/);
    assert.match(en, /Account balance.*Unknown/);
    assert.doesNotMatch(en, /[\u3400-\u9fff]|Offline fixture/);
    const zh = render(data, initialView(), {
      width: 120,
      color: false,
      lang: "zh",
    });
    assert.match(zh, /本地预算/);
    assert.match(zh, /账号余额/);
  } finally {
    await gateway.close();
  }
});
