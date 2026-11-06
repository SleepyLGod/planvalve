import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { GatewayError, type ObjectValue, type LedgerRecord } from "./types.ts";
const ajv = new Ajv({
  strictSchema: true,
  strictTypes: false,
  strictRequired: false,
  allErrors: false,
  validateFormats: true,
  addUsedSchema: false,
});
function invalid(message: string): never {
  throw new GatewayError(400, "invalid_request", message);
}
export function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function translate(
  value: unknown,
  profile: "strict" | "lotus",
  model = "offline-model",
  protocol: "responses" | "chat" = "responses",
): {
  payload: ObjectValue;
  validateText: (text: string) => void;
  transformations: LedgerRecord["transformations"];
} {
  if (!object(value)) invalid("Expected JSON object");
  if (value.model !== model)
    invalid("Requested model is not available in this run");
  if (value.stream !== undefined && value.stream !== false)
    invalid("Client streaming is not implemented");
  if (value.n !== undefined && value.n !== 1) invalid("Only n=1 is supported");
  if (!Array.isArray(value.messages) || !value.messages.length)
    invalid("messages must be a nonempty array");
  const transformations: LedgerRecord["transformations"] = [];
  const omit = new Set([
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "thinking",
  ]);
  const accepted = new Set([
    "model",
    "messages",
    "response_format",
    "stream",
    "n",
  ]);
  const standard = new Set([
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
  ]);
  if (protocol === "chat") for (const key of standard) accepted.add(key);
  for (const [key, v] of Object.entries(value)) {
    if (accepted.has(key)) continue;
    if (profile === "lotus" && omit.has(key))
      transformations.push({
        parameter: key,
        requested: v,
        effect:
          key === "thinking"
            ? "omitted; does not guarantee reasoning is disabled"
            : "omitted; requested constraint is not enforced",
      });
    else invalid(`Unsupported parameter: ${key}`);
  }
  const input = value.messages.map((message) => {
    if (
      !object(message) ||
      !["system", "developer", "user", "assistant"].includes(
        String(message.role),
      ) ||
      typeof message.content !== "string" ||
      Object.keys(message).some((k) => !["role", "content"].includes(k))
    )
      invalid("Only text messages with role and content are supported");
    return {
      role:
        protocol === "responses" && message.role === "system"
          ? "developer"
          : message.role,
      content: message.content,
    };
  });
  const payload: ObjectValue =
    protocol === "responses"
      ? { model, input, store: false, stream: true }
      : { model, messages: input, stream: false };
  if (protocol === "chat")
    for (const key of standard) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== "number" || !Number.isFinite(value[key]))
          invalid(`Invalid ${key}`);
        payload[key] = value[key];
      }
    }
  let jsonMode = false;
  let validator: ValidateFunction | undefined;
  if (value.response_format !== undefined) {
    const f = value.response_format;
    if (!object(f)) invalid("Invalid response_format");
    if (f.type === "json_object" && Object.keys(f).length === 1) {
      jsonMode = true;
      payload.text = { format: { type: "json_object" } };
    } else if (f.type === "text" && Object.keys(f).length === 1) {
      payload.text = { format: { type: "text" } };
    } else if (f.type === "json_schema" && object(f.json_schema)) {
      const s = f.json_schema;
      if (
        Object.keys(f).some((k) => !["type", "json_schema"].includes(k)) ||
        Object.keys(s).some(
          (k) => !["name", "schema", "strict", "description"].includes(k),
        ) ||
        typeof s.name !== "string" ||
        !s.name ||
        !object(s.schema) ||
        (s.strict !== undefined && typeof s.strict !== "boolean") ||
        (s.description !== undefined && typeof s.description !== "string")
      )
        invalid("Invalid json_schema");
      try {
        validator = ajv.compile(s.schema);
      } catch {
        invalid("JSON schema could not be compiled");
      }
      jsonMode = true;
      payload.text = { format: { type: "json_schema", ...s } };
    } else invalid("Unsupported response_format");
  }
  if (protocol === "chat") {
    delete payload.text;
    if (value.response_format !== undefined)
      payload.response_format = value.response_format;
  }
  return {
    payload,
    transformations,
    validateText(text) {
      if (!jsonMode) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayError(
          502,
          "invalid_json",
          "Upstream output is not valid JSON; no repair attempted",
        );
      }
      if (!object(parsed))
        throw new GatewayError(
          502,
          "invalid_json",
          "JSON output must be an object",
        );
      if (validator && !validator(parsed))
        throw new GatewayError(
          502,
          "schema_mismatch",
          "Upstream JSON does not match the supplied schema",
        );
    },
  };
}
export function normalizeUsage(raw: unknown): {
  usage: ObjectValue;
  completeness: "complete" | "partial";
} {
  if (!object(raw))
    throw new GatewayError(502, "usage_missing", "Core usage is missing");
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const i = raw.input_tokens,
    o = raw.output_tokens,
    total = raw.total_tokens;
  if (!valid(i) || !valid(o) || !valid(total) || i + o !== total)
    throw new GatewayError(
      502,
      "usage_invalid",
      "Core token counts are missing or inconsistent",
    );
  const usage: ObjectValue = {
    prompt_tokens: i,
    completion_tokens: o,
    total_tokens: total,
  };
  const cached = object(raw.input_tokens_details)
    ? raw.input_tokens_details.cached_tokens
    : undefined;
  const reasoning = object(raw.output_tokens_details)
    ? raw.output_tokens_details.reasoning_tokens
    : undefined;
  if (cached !== undefined) {
    if (!valid(cached) || cached > i)
      throw new GatewayError(502, "usage_invalid", "Invalid cache detail");
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  if (reasoning !== undefined) {
    if (!valid(reasoning) || reasoning > o)
      throw new GatewayError(502, "usage_invalid", "Invalid reasoning detail");
    usage.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return {
    usage,
    completeness:
      cached === undefined || reasoning === undefined ? "partial" : "complete",
  };
}
