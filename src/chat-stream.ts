import type OpenAI from "openai";
import type { RequestTiming } from "./timing.ts";
import { GatewayError } from "./types.ts";

type Chunk = OpenAI.ChatCompletionChunk;

type ToolParts = {
  id?: string;
  type?: string;
  name?: string;
  arguments?: string[];
};

const maxOutput = 2 * 1024 * 1024;

function invalidStream(): never {
  throw new GatewayError(
    502,
    "upstream_incomplete",
    "Invalid upstream completion stream",
  );
}

/** Assemble one choice, keeping the SDK as the sole SSE parser. */
export async function collectChat(
  stream: AsyncIterable<Chunk>,
  signal: AbortSignal,
  onUsage: (usage: NonNullable<Chunk["usage"]>) => void,
  timing?: RequestTiming,
) {
  const content: string[] = [];
  const tools = new Map<number, ToolParts>();
  let size = 0;
  let role: string | undefined;
  let refusal = false;
  let hasContent = false;
  let finishReason: string | undefined;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1)
      invalidStream();
    const choice = chunk.choices[0];
    if (choice) {
      if (choice.index !== 0 || finishReason || !choice.delta) invalidStream();
      const delta = choice.delta;
      role = delta.role ?? role;
      refusal ||= Boolean(delta.refusal);
      if (delta.content != null && typeof delta.content !== "string")
        invalidStream();
      hasContent ||= typeof delta.content === "string";
      if (delta.content) {
        content.push(delta.content);
        size += delta.content.length;
        timing?.text();
      }
      for (const part of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(part.index) || part.index < 0)
          invalidStream();
        let tool = tools.get(part.index);
        if (!tool) {
          tool = {};
          tools.set(part.index, tool);
          size += 64; // Account for the serialized tool-call envelope.
        }
        if (part.id !== undefined) {
          if (tool.id !== undefined && tool.id !== part.id) invalidStream();
          if (tool.id === undefined) size += part.id.length;
          tool.id = part.id;
        }
        if (part.type !== undefined) tool.type = part.type;
        const name = part.function?.name;
        const args = part.function?.arguments;
        if (name) {
          tool.name = (tool.name ?? "") + name;
          if (tool.name.length > 64) invalidStream();
          size += name.length;
        }
        if (args !== undefined) {
          if (typeof args !== "string") invalidStream();
          const parts = (tool.arguments ??= []);
          if (args) {
            parts.push(args);
            size += args.length;
            timing?.toolArguments();
          }
        }
        if (size > maxOutput)
          throw new GatewayError(
            502,
            "response_too_large",
            "Upstream completion exceeds 2 MiB",
          );
      }
      if (size > maxOutput)
        throw new GatewayError(
          502,
          "response_too_large",
          "Upstream completion exceeds 2 MiB",
        );
      finishReason = choice.finish_reason ?? undefined;
    }
    if (chunk.usage != null) {
      if (!finishReason) invalidStream();
      onUsage(chunk.usage);
      break;
    }
  }
  if (!finishReason)
    throw new GatewayError(
      502,
      "stream_interrupted",
      "Stream ended without a completion reason",
    );
  const toolCalls = Array.from({ length: tools.size }, (_, index) => {
    const tool = tools.get(index);
    if (!tool) invalidStream();
    return {
      id: tool.id,
      type: tool.type,
      function: { name: tool.name, arguments: tool.arguments?.join("") },
    };
  });
  return {
    finish_reason: finishReason,
    message: {
      role,
      content: hasContent ? content.join("") : null,
      refusal,
      tool_calls: toolCalls,
    },
  };
}
