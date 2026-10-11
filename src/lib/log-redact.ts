const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
const BEARER_PATTERN = /bearer\s+[a-z0-9._~+/=-]+/gi;
const KEY_PATTERN = /((?:api[_-]?key|secret|token|signature|x-amz-[a-z-]+)\s*[=:]\s*)[^\s&"']+/gi;
const PATH_PATTERN = /(?:\/(?:tmp|home|var|Users|srv|opt|data)\/)[^\s"'<>]*/g;

/** Keeps only the scheme and host of a URL so signed queries, object keys and task IDs never reach logs. */
export function redactUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "[none]";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "[redacted]";
  }
}

/** Redacts URLs, bearer tokens, key-like pairs and filesystem paths from free text and truncates it. */
export function redactText(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : safeStringify(value);
  const redacted = text
    .replace(URL_PATTERN, (match) => redactUrl(match))
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(KEY_PATTERN, "$1[redacted]")
    .replace(PATH_PATTERN, "[path]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

/** Log-safe summary of an unknown error: name and redacted message only, never stacks or response bodies. */
export function safeLogError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${redactText(error.message)}`;
  return redactText(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
