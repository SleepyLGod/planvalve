import { ui, type Language } from "./language.ts";
import stringWidth from "string-width";
import type { MonitorData } from "./monitor.ts";
import type { HistoryRecord, RequestPage } from "./types.ts";
import { object } from "./compatibility.ts";
import { chatgptUsageUrl, subscriptionUsageLimitCode } from "./rate-limit.ts";
export interface ViewState {
  scope: "current" | "all";
  selected: number;
  detail: boolean;
  raw: boolean;
  scroll: number;
  pageCursors: (number | undefined)[];
  error?: string;
}
export const initialView = (): ViewState => ({
  scope: "current",
  selected: 0,
  detail: false,
  raw: false,
  scroll: 0,
  pageCursors: [undefined],
});
const segments = new Intl.Segmenter();
/** Escape data before writing it into the terminal; API field names remain in raw view only. */
export function safeText(value: unknown): string {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
/** All layout uses terminal display cells, including Chinese glyphs and numeric alignment. */
export function cell(
  value: unknown,
  width: number,
  align: "left" | "right" = "left",
): string {
  width = Math.max(0, width);
  const clean = safeText(value);
  let text = "";
  const truncated = stringWidth(clean) > width && width > 0;
  const limit = truncated ? width - 1 : width;
  for (const { segment } of segments.segment(clean)) {
    if (stringWidth(text + segment) > limit) break;
    text += segment;
  }
  if (truncated) text += "…";
  const padding = " ".repeat(Math.max(0, width - stringWidth(text)));
  return align === "right" ? padding + text : text + padding;
}
function clock(value: string, full = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return full
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
    : time;
}
function sides(left: unknown, right: unknown, width: number): string {
  const r = safeText(right).trim();
  return cell(left, Math.max(0, width - stringWidth(r) - 1)) + " " + r;
}

function pair(label: string, value: unknown, width: number): string {
  const labelWidth = Math.min(12, Math.floor(width / 2));
  return (
    cell(label, labelWidth) +
    cell(value, Math.max(0, width - labelWidth), "right")
  );
}
function panel(title: string, rows: string[], width: number): string[] {
  const inside = Math.max(0, width - 4);
  const heading = cell(" " + title + " ", Math.max(0, width - 2)).trimEnd();
  return [
    "┌" +
      heading +
      "─".repeat(Math.max(0, width - 2 - stringWidth(heading))) +
      "┐",
    ...rows.map((r) => "│ " + cell(r, inside) + " │"),
    "└" + "─".repeat(Math.max(0, width - 2)) + "┘",
  ];
}
function wrapped(lines: string[], width: number): string[] {
  const output: string[] = [];
  for (const raw of lines) {
    let text = "";
    for (const { segment } of segments.segment(safeText(raw))) {
      if (text && stringWidth(text + segment) > width) {
        output.push(text);
        text = "";
      }
      text += segment;
    }
    output.push(text);
  }
  return output;
}
function detailLines(
  r: HistoryRecord,
  now: string,
  width: number,
  raw: boolean,
  lang: Language,
): string[] {
  const { t, count, duration, stateLabel } = ui(lang);
  if (raw)
    return [
      " " + t("原始数据 · API 字段名保持原样"),
      "",
      ...wrapped(JSON.stringify(r, null, 2).split("\n"), width),
    ];
  const w = Math.max(0, width - 4),
    u = r.usage;
  const cached = object(u?.prompt_tokens_details)
    ? u.prompt_tokens_details.cached_tokens
    : undefined;
  const reasoning = object(u?.completion_tokens_details)
    ? u.completion_tokens_details.reasoning_tokens
    : undefined;
  const writes = object(r.rawUsage?.input_tokens_details)
    ? r.rawUsage.input_tokens_details.cache_write_tokens
    : undefined;
  const format: Record<string, string> = {
    text: t("普通文本"),
    json_object: t("JSON 对象"),
    json_schema: t("JSON 结构"),
  };
  const info = [
    pair(t("请求编号"), r.id, w),
    pair(t("状态"), stateLabel(r.status), w),
    pair(
      t("所属运行"),
      r.historical ? t("历史记录 · 最后已知状态") : t("本次运行"),
      w,
    ),
    pair(t("接收时间"), clock(r.receivedAt, true), w),
    pair(
      t("发送上游"),
      r.inferenceDispatched === false
        ? t("未发送")
        : r.dispatchedAt
          ? clock(r.dispatchedAt, true)
          : t("未知"),
      w,
    ),
    pair(
      t("等待耗时"),
      duration(r.receivedAt, r.startedAt ?? r.finishedAt ?? now),
      w,
    ),
    pair(t("执行耗时"), duration(r.startedAt, r.finishedAt ?? now), w),
    pair(
      t("响应头"),
      r.headersAt ? duration(r.startedAt, r.headersAt) : t("未知"),
      w,
    ),
    pair(
      t("首个文本"),
      r.firstTextAt ? duration(r.startedAt, r.firstTextAt) : t("未知"),
      w,
    ),
    pair(
      t("完成事件"),
      r.terminalAt ? duration(r.startedAt, r.terminalAt) : t("未知"),
      w,
    ),
    pair(
      t("结束原因"),
      r.endReason === "completed"
        ? stateLabel("completed")
        : (r.endReason ?? t("未知")),
      w,
    ),
    pair(t("模型"), r.model ?? t("未知"), w),
    pair(t("输出格式"), format[r.outputFormat ?? "text"] ?? t("其他"), w),
  ];
  const usage = [
    pair(t("输入"), count(u?.prompt_tokens), w),
    pair(t("输出"), count(u?.completion_tokens), w),
    pair(t("总计"), count(u?.total_tokens), w),
    pair(t("缓存命中"), count(cached), w),
    pair(t("推理"), count(reasoning), w),
    pair(t("写入缓存"), count(writes), w),
  ];
  const lines = [
    " " + t("请求详情"),
    ...panel(t("用量明细 · 词元"), usage, width),
    "",
    ...panel(t("请求信息 · 本机时间"), info, width),
    "",
  ];
  const names: Record<string, string> = {
    temperature: t("温度"),
    top_p: t("采样范围"),
    max_tokens: t("输出上限"),
    max_completion_tokens: t("输出上限"),
    thinking: t("推理设置"),
  };
  lines.push(
    ...panel(
      t("参数处理"),
      r.transformations.length
        ? r.transformations.map((change) =>
            pair(
              names[change.parameter] ?? t("其他参数"),
              `${safeText(JSON.stringify(change.requested))} → ${ui(lang).t("已省略")}`,
              w,
            ),
          )
        : [cell(t("无参数省略"), w)],
      width,
    ),
  );
  if (r.upstreamHttp)
    lines.push(
      ...panel(
        t("上游信息"),
        [
          pair("HTTP", count(r.upstreamHttp.status), w),
          pair(t("上游请求"), r.upstreamHttp.requestId ?? t("未知"), w),
          pair("Retry-After", r.upstreamHttp.retryAfter ?? t("未知"), w),
          pair(t("错误码"), r.error ?? "—", w),
        ],
        width,
      ),
    );
  if (r.error) lines.push(" " + t("请求未成功；按 R 查看原始错误码。"));
  lines.push(" " + t("缓存命中属于输入，推理属于输出，均不重复计入总计。"));
  return lines;
}
interface Column {
  label: string;
  width: number;
  right?: boolean;
}
function columns(width: number, lang: Language): Column[] {
  const { t } = ui(lang);
  const full = width >= 90;
  const cols: Column[] = full
    ? [
        { label: t("请求编号"), width: 10 },
        { label: t("状态"), width: 8 },
        { label: t("时间"), width: 8 },
        { label: t("等待"), width: 10, right: true },
        { label: t("执行"), width: 10, right: true },
        { label: t("输入"), width: 7, right: true },
        { label: t("输出"), width: 7, right: true },
        { label: t("总计"), width: 8, right: true },
      ]
    : [
        { label: t("请求编号"), width: 8 },
        { label: t("状态"), width: 6 },
        { label: t("总计"), width: 6, right: true },
      ];
  const available = Math.max(0, width - 4 - (cols.length - 1) * 2);
  let extra = available - cols.reduce((s, c) => s + c.width, 0),
    i = 0;
  while (extra > 0) {
    cols[i++ % cols.length]!.width++;
    extra--;
  }
  return cols;
}
function tableLine(
  values: unknown[],
  cols: Column[],
  selected = false,
): string {
  return (
    "│" +
    (selected ? "▸ " : "  ") +
    cols
      .map((c, i) => cell(values[i], c.width, c.right ? "right" : "left"))
      .join("  ") +
    "│"
  );
}
/** Render the same Chinese-first view in both a terminal dashboard and one-shot output. */
export function render(
  data: MonitorData | undefined,
  state: ViewState,
  options: { width: number; height?: number; color: boolean; lang?: Language },
): string {
  const lang = options.lang ?? "zh";
  const { t, count, duration, stateLabel } = ui(lang);
  const width = Math.max(1, options.width),
    out: string[] = [];
  const line = (text: string, style?: string) => {
    const value = cell(text, width);
    out.push(options.color && style ? `\x1b[${style}m${value}\x1b[0m` : value);
  };
  line(
    sides(
      " PlanValve",
      t(
        data?.status.mode === "subscription-probe"
          ? "官方订阅 · 真实测试"
          : data?.status.mode === "chatgpt-subscription"
            ? "官方订阅 · 用户授权"
            : data?.status.mode === "openai-api-key"
              ? "OpenAI API · 用户密钥"
              : "离线模拟 · 无真实调用",
      ),
      width,
    ),
    "1;36",
  );
  if (!data) {
    line(
      state.error
        ? " " + t("连接中断 · 等待本地网关")
        : " " + t("正在连接本地网关"),
      state.error ? "31" : "33",
    );
    line(" " + t("监控不会发起模型请求。"));
  } else {
    const { status: s, page } = data;
    const connection = state.error
      ? t("连接中断 · 保留上次数据")
      : s.queue.paused
        ? t("已暂停")
        : s.queue.closed
          ? t("已停止")
          : t("已连接");
    line(
      sides(
        " " + connection,
        t("更新") + " " + clock(s.asOf, true) + " ",
        width,
      ),
      state.error ? "31" : s.queue.paused ? "33" : "32",
    );
    if (state.detail && page.items[state.selected]) {
      const detail = detailLines(
        page.items[state.selected]!,
        s.asOf,
        width,
        state.raw,
        lang,
      );
      const room = options.height
        ? Math.max(1, options.height - out.length - 2)
        : detail.length;
      const start = Math.min(state.scroll, Math.max(0, detail.length - room));
      for (const text of detail.slice(start, start + room)) line(text);
    } else {
      line("");
      if (width >= 80) {
        const lw = Math.floor((width - 2) / 2),
          rw = width - 2 - lw;
        const lim = (n: number | null) => (n === null ? t("不限") : count(n));
        const left = panel(
          t("运行状态"),
          [
            pair(
              t("执行中"),
              `${s.queue.running} / ${s.queue.concurrency}`,
              lw - 4,
            ),
            pair(
              t("排队中"),
              `${s.queue.waiting} / ${s.queue.capacity}`,
              lw - 4,
            ),
            pair(
              t("已用请求"),
              `${count(s.budget.requests.used)} / ${lim(s.budget.requests.limit)}`,
              lw - 4,
            ),
            pair(t("剩余请求"), lim(s.budget.requests.remaining), lw - 4),
          ],
          lw,
        );
        const right = panel(
          t("本次用量 · 词元"),
          [
            pair(t("输入"), count(s.usage.inputTokens), rw - 4),
            pair(t("输出"), count(s.usage.outputTokens), rw - 4),
            pair(t("总计"), count(s.usage.totalTokens), rw - 4),
            pair(t("本地预算"), lim(s.budget.tokens.remaining), rw - 4),
          ],
          rw,
        );
        for (let i = 0; i < left.length; i++) line(left[i] + "  " + right[i]);
      } else {
        line(
          ` ${t("执行")} ${s.queue.running}/${s.queue.concurrency} · ${t("排队中")} ${s.queue.waiting}/${s.queue.capacity}`,
        );
        line(
          ` ${t("输入")} ${count(s.usage.inputTokens)} · ${t("输出")} ${count(s.usage.outputTokens)} · ${t("总计")} ${count(s.usage.totalTokens)}`,
        );
        line(
          ` ${t("已用请求")} ${s.budget.requests.used} · ${t("剩余请求")} ${s.budget.requests.remaining ?? t("不限")}`,
        );
      }
      const known = (v: { knownTokens: number; unknownRequests: number }) =>
        `${count(v.knownTokens)}${v.unknownRequests ? (lang === "en" ? ` (+${v.unknownRequests} unknown)` : `（另 ${v.unknownRequests} 次未知）`) : ""}`;
      line(
        ` ${t("缓存命中")} ${known(s.usage.cached)}   ${t("推理")} ${known(s.usage.reasoning)}   ${t("写入缓存")} ${known(s.usage.cacheWrite)}   ${t("用量未知")} ${s.usage.unknownUsageRequests}`,
      );
      line(
        ` ${t("启动间隔")} ${s.queue.minStartIntervalMs} ${t("毫秒")} · ${t("历史存储")} ${s.storage.healthy ? t("正常") : t("异常")} · ${t("本次运行")} ${s.runId.slice(0, 8)}`,
        "90",
      );
      line(
        ` ${t("上游在途")} ${count(s.queue.inFlight)} · ${t("准备中")} ${count(s.queue.preparing)} · ${t("每分钟上限")} ${s.dispatch ? (s.dispatch.maxRequestsPerMinute ?? t("不限")) : t("未知")}`,
      );
      if (s.dispatch) {
        const labels = {
          ready: "可派发",
          spacing: "节奏等待",
          cooldown: "上游冷却",
          paused: "已暂停",
          closed: "已停止",
        };
        line(
          ` ${t("等待派发")} ${t(labels[s.dispatch.state])} · ${s.dispatch.waitMs} ${t("毫秒")} · ${t("生效间隔")} ${s.dispatch.effectiveStartIntervalMs} ${t("毫秒")}`,
          s.dispatch.state === "cooldown" ? "33" : "90",
        );
      }
      if (s.mode === "openai-api-key" || s.mode === "chatgpt-subscription") {
        line(
          ` ${t("授权")} ${t(s.authorization?.state ?? "未知")} · ${t("账号余额")} ${t("未知")} · ${t("实际费用")} ${t("未知")}`,
        );
        if (s.pauseReason)
          line(` ${t("暂停原因")} ${safeText(s.pauseReason)}`, "33");
        if (
          s.mode === "chatgpt-subscription" &&
          s.pauseReason === subscriptionUsageLimitCode
        )
          line(` ${t("管理用量")}  ${chatgptUsageUrl}`, "33");
      }
      line("");
      line(
        sides(
          ` ${t("请求记录")} · ${state.scope === "current" ? t("本次运行") : t("全部历史 · 状态为最后已知")}`,
          lang === "en"
            ? `Page ${state.pageCursors.length}`
            : `第 ${state.pageCursors.length} 页`,
          width,
        ),
        "1",
      );
      const cols = columns(width, lang);
      line("┌" + "─".repeat(Math.max(0, width - 2)) + "┐", "90");
      line(
        tableLine(
          cols.map((c) => c.label),
          cols,
        ),
        "90",
      );
      line("├" + "─".repeat(Math.max(0, width - 2)) + "┤", "90");
      const room = options.height
        ? Math.max(0, options.height - out.length - 3)
        : page.items.length;
      const start = room
        ? Math.max(
            0,
            Math.min(
              state.selected - Math.floor(room / 2),
              page.items.length - room,
            ),
          )
        : 0;
      if (!page.items.length)
        line("│ " + cell(t("暂无请求"), Math.max(0, width - 4)) + " │", "90");
      for (let i = start; i < Math.min(page.items.length, start + room); i++) {
        const r = page.items[i]!,
          u = r.usage;
        const values =
          width >= 90
            ? [
                r.id.slice(0, 8),
                stateLabel(r.status),
                clock(r.receivedAt),
                duration(r.receivedAt, r.startedAt ?? r.finishedAt ?? s.asOf),
                duration(r.startedAt, r.finishedAt ?? s.asOf),
                count(u?.prompt_tokens),
                count(u?.completion_tokens),
                count(u?.total_tokens),
              ]
            : [r.id.slice(0, 8), stateLabel(r.status), count(u?.total_tokens)];
        line(
          tableLine(values, cols, i === state.selected),
          i === state.selected ? "1;48;5;24;37" : undefined,
        );
      }
      line("└" + "─".repeat(Math.max(0, width - 2)) + "┘", "90");
    }
  }
  const footer = state.detail
    ? t(" ↑↓ 滚动   R ") +
      (state.raw ? t("返回摘要") : t("原始数据")) +
      t("   Esc 返回   Q 退出监控")
    : t(" ↑↓ 选择   回车 明细   ←→ 翻页   Tab 历史   Q 退出监控");
  if (options.height) {
    out.splice(Math.max(0, options.height - 1));
    while (out.length < options.height - 1) out.push(" ".repeat(width));
  }
  line(footer, "90");
  return out.join("\n");
}
export function keyAction(
  state: ViewState,
  key: string,
  page?: RequestPage,
): { state: ViewState; refresh: boolean; quit: boolean } {
  const next = { ...state, pageCursors: [...state.pageCursors] };
  let refresh = false;
  if (key === "q" || key === "ctrl-c")
    return { state: next, refresh: false, quit: true };
  if (key === "escape") {
    next.detail = false;
    next.raw = false;
    next.scroll = 0;
  }
  if (key === "return" && page?.items.length) {
    next.detail = !next.detail;
    next.raw = false;
    next.scroll = 0;
  }
  if (key === "r" && next.detail) {
    next.raw = !next.raw;
    next.scroll = 0;
  }
  if (["up", "down", "pageup", "pagedown"].includes(key)) {
    const step =
      (key === "up" || key === "pageup" ? -1 : 1) *
      (key.startsWith("page") ? 10 : 1);
    if (next.detail) next.scroll = Math.max(0, next.scroll + step);
    else
      next.selected = Math.max(
        0,
        Math.min((page?.items.length ?? 1) - 1, next.selected + step),
      );
  }
  if (key === "tab") {
    next.scope = next.scope === "current" ? "all" : "current";
    next.pageCursors = [undefined];
    next.selected = 0;
    next.detail = false;
    next.raw = false;
    next.scroll = 0;
    refresh = true;
  }
  if (
    !next.detail &&
    key === "right" &&
    page?.nextCursor &&
    page.nextCursor !== next.pageCursors.at(-1)
  ) {
    next.pageCursors.push(page.nextCursor);
    next.selected = 0;
    refresh = true;
  }
  if (!next.detail && key === "left" && next.pageCursors.length > 1) {
    next.pageCursors.pop();
    next.selected = 0;
    refresh = true;
  }
  return { state: next, refresh, quit: false };
}
