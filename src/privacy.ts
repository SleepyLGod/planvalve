/** Redact known credentials recursively before anything reaches local diagnostics. */
export class Redactor {
  private secrets = new Set<string>();
  add(...values: (string | undefined)[]): void {
    for (const value of values) if (value) this.secrets.add(value);
  }
  text(value: string): string {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[REDACTED]");
    return result
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "[REDACTED_JWT]",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]");
  }
  value<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (key, item) =>
        /^(access_token|refresh_token|id_token|authorization|api_key)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : typeof item === "string"
            ? this.text(item)
            : item,
      ),
    ) as T;
  }
}
