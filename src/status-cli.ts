import type { Language } from "./language.ts";
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import { localOrigin, readMonitor, type MonitorData } from "./monitor.ts";
import { render, initialView, keyAction } from "./view.ts";
function argumentsFor(args: string[]) {
  let url = "http://127.0.0.1:8787",
    once = false,
    json = false;
  let lang: Language = "zh";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--once") once = true;
    else if (args[i] === "--lang" && ["zh", "en"].includes(args[i + 1] ?? ""))
      lang = args[++i] as Language;
    else if (args[i] === "--json") {
      json = true;
      once = true;
    } else if (args[i] === "--url" && args[i + 1]) url = args[++i]!;
    else
      throw new Error(
        "Usage: npm run status -- [--once | --json] [--lang zh|en] [--url http://127.0.0.1:8787]",
      );
  }
  return { url: localOrigin(url), once, json, lang };
}
async function main(): Promise<void> {
  const options = argumentsFor(process.argv.slice(2));
  if (options.once || !process.stdin.isTTY || !process.stdout.isTTY) {
    const data = await readMonitor(options.url, "current");
    process.stdout.write(
      options.json
        ? JSON.stringify(data, null, 2) + "\n"
        : render(data, initialView(), {
            width: 110,
            color: false,
            lang: options.lang,
          }) + "\n",
    );
    return;
  }
  let state = initialView(),
    data: MonitorData | undefined;
  let stopped = false,
    busy = false,
    pending = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const color =
    !Object.hasOwn(process.env, "NO_COLOR") && process.env.TERM !== "dumb";
  const draw = () =>
    process.stdout.write(
      "\x1b[H\x1b[2J" +
        render(data, state, {
          width: Math.max(1, (process.stdout.columns || 100) - 1),
          height: process.stdout.rows || 24,
          color,
          lang: options.lang,
        }) +
        "\x1b[J",
    );
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    abort.abort();
    process.stdin.off("keypress", keypress);
    process.stdout.off("resize", draw);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.off("exit", shutdown);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  const poll = async () => {
    if (stopped) return;
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    pending = false;
    clearTimeout(timer);
    const scope = state.scope,
      cursor = state.pageCursors.at(-1);
    try {
      const latest = await readMonitor(
        options.url,
        scope,
        cursor,
        abort.signal,
      );
      if (scope === state.scope && cursor === state.pageCursors.at(-1)) {
        const selectedId = data?.page.items[state.selected]?.id;
        if (
          data?.status.runId !== latest.status.runId &&
          scope === "current" &&
          cursor !== undefined
        ) {
          state.pageCursors = [undefined];
          pending = true;
        } else {
          const index = selectedId
            ? latest.page.items.findIndex((r) => r.id === selectedId)
            : -1;
          state.selected =
            index >= 0
              ? index
              : Math.min(
                  state.selected,
                  Math.max(0, latest.page.items.length - 1),
                );
          state.error = undefined;
          data = latest;
        }
      } else pending = true;
    } catch (error) {
      if (!stopped)
        state.error = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      if (!stopped) {
        draw();
        timer = setTimeout(() => void poll(), pending ? 0 : 1000);
      }
    }
  };
  const keypress = (_text: string, key: Key) => {
    const action = keyAction(
      state,
      key.ctrl && key.name === "c" ? "ctrl-c" : (key.name ?? ""),
      data?.page,
    );
    state = action.state;
    if (action.quit) shutdown();
    else {
      draw();
      if (action.refresh) void poll();
    }
  };
  try {
    process.once("exit", shutdown);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", keypress);
    process.stdout.on("resize", draw);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    draw();
    await poll();
  } catch (error) {
    shutdown();
    throw error;
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
