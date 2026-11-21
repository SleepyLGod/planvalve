export function chatEvents(events: object[], init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
      "data: [DONE]\n\n",
    { ...init, headers },
  );
}

/** Convert an existing fake full completion into equivalent upstream SSE. */
export function chatFixture(
  completion: {
    id?: string;
    model?: string;
    created?: number;
    choices: readonly unknown[];
    usage?: unknown;
  },
  init?: ResponseInit,
): Response {
  const base = {
    id: completion.id ?? "fake-completion",
    model: completion.model ?? "test-model",
    created: completion.created ?? 1,
    object: "chat.completion.chunk",
  };
  const choices = completion.choices.map((value) => {
    const choice = value as {
      index: number;
      finish_reason: string;
      message: { tool_calls?: readonly object[] } & Record<string, unknown>;
    };
    const { tool_calls, ...message } = choice.message;
    return {
      index: choice.index,
      delta: {
        ...message,
        ...(tool_calls
          ? {
              tool_calls: tool_calls.map((call, index) => ({ ...call, index })),
            }
          : {}),
      },
      finish_reason: choice.finish_reason,
    };
  });
  return chatEvents(
    [
      { ...base, choices },
      ...(completion.usage
        ? [{ ...base, choices: [], usage: completion.usage }]
        : []),
    ],
    init,
  );
}
