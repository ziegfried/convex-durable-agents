import type { ActionCtx, RetryBackoffConfig } from "../client/types.js";

export type RetryErrorKind =
  | "network"
  | "rate_limited"
  | "provider_5xx"
  | "context_window_exceeded"
  | "insufficient_credits"
  | "invalid_request"
  | "auth"
  | "unknown";

export type RetryErrorSignal = {
  name?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  isRetryable?: boolean;
  retryErrorReason?: "maxRetriesExceeded" | "errorNotRetryable" | "abort";
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  providerCode?: string;
  providerType?: string;
};

export type RetryErrorClassification = {
  kind: RetryErrorKind;
  retryable: boolean;
  requiresExplicitHandling: boolean;
  signal: RetryErrorSignal;
};

export type RetryDecision =
  | { action: "retry"; delayMs?: number; reason?: string }
  | {
      action: "fail";
      kind?: RetryErrorKind;
      reason?: string;
      requiresExplicitHandling?: boolean;
    };

export type RetryContext = {
  threadId: string;
  streamId: string;
  attempt: number;
  maxAttempts: number;
  toolCallsScheduled: number;
  streamPartCount: number;
  error: unknown;
  normalizedError: string;
  defaultClassification: RetryErrorClassification;
  defaultDecision: RetryDecision;
};

export type RetryOptions = {
  enabled?: boolean;
  maxAttempts?: number;
  backoff?: RetryBackoffConfig;
  retryAfterToolCalls?: boolean;
  classify?: (ctx: ActionCtx, input: RetryContext) => RetryDecision | Promise<RetryDecision>;
};

export type ToolErrorInfo = {
  message: string;
  name?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  causeMessage?: string;
};

type RecordLike = Record<string, unknown>;

export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

export const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  strategy: "exponential",
  initialDelayMs: 250,
  multiplier: 2,
  maxDelayMs: 4000,
  jitter: true,
};

const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /^4(00|13)\s*(status code)?\s*\(no body\)/i,
];

const INSUFFICIENT_CREDITS_PATTERNS = [
  /insufficient[_ ]quota/i,
  /out of credits/i,
  /quota exceeded/i,
  /credit balance/i,
  /freeusagelimiterror/i,
  /usage limit reached/i,
];

const AUTH_PATTERNS = [/unauthorized/i, /forbidden/i, /invalid api key/i, /authentication/i];

const RATE_LIMIT_PATTERNS = [/too many requests/i, /rate.?limit/i, /resource.?exhausted/i];

const INVALID_REQUEST_PATTERNS = [/invalid request/i, /invalid argument/i, /validation error/i, /invalid prompt/i];

const NETWORK_PATTERNS = [
  /network/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /ehostunreach/i,
  /connection reset/i,
  /connection refused/i,
  /fetch failed/i,
  /socket hang up/i,
  /upstream.?connect/i,
  /other.?side.?closed/i,
  /cannot connect to api/i,
  /(?:connection|stream|socket)\s+terminated/i,
];

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EPIPE",
  "ENOTFOUND",
  "CONNECTIONREFUSED",
  "CONNECTIONCLOSED",
  "FAILEDTOOPENSOCKET",
]);

const CONTEXT_OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "prompt_too_long",
  "token_limit_exceeded",
]);

const INSUFFICIENT_CREDITS_CODES = new Set([
  "insufficient_quota",
  "usage_limit_reached",
  "usage_not_included",
  "credit_balance_too_low",
  "quota_exceeded",
]);

const RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "too_many_requests", "resource_exhausted"]);

const AUTH_CODES = new Set(["invalid_api_key", "authentication_error", "unauthorized", "forbidden"]);

const INVALID_REQUEST_CODES = new Set(["invalid_request_error", "invalid_prompt", "bad_request"]);

function asRecord(value: unknown): RecordLike | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as RecordLike;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseStatusCodeFromMessage(message: string): number | undefined {
  const patterns = [/status(?: code)?[:=\s]+(\d{3})/i, /\b(\d{3})\s*(?:status code)/i, /^\s*(\d{3})\b/];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const status = Number.parseInt(match[1], 10);
    if (!Number.isNaN(status)) return status;
  }
  return undefined;
}

function parseJsonRecord(value: unknown): RecordLike | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function normalizeHeaderRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue === "string") {
      normalized[key.toLowerCase()] = headerValue;
    } else if (typeof headerValue === "number" || typeof headerValue === "boolean") {
      normalized[key.toLowerCase()] = String(headerValue);
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseRetryErrorReason(value: unknown): RetryErrorSignal["retryErrorReason"] | undefined {
  if (value === "maxRetriesExceeded" || value === "errorNotRetryable" || value === "abort") {
    return value;
  }
  return undefined;
}

function getNestedErrorFields(payload: RecordLike): { code?: string; type?: string } {
  const nestedError = asRecord(payload.error);
  const code = asString(nestedError?.code) ?? asString(payload.code);
  const type = asString(nestedError?.type) ?? asString(payload.type);
  return { code, type };
}

function includesAnyPattern(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function clampDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return 0;
  }
  return Math.floor(delayMs);
}

export function computeBackoffDelayMs(attempt: number, backoff: RetryBackoffConfig | undefined): number {
  const policy = backoff ?? DEFAULT_RETRY_BACKOFF;
  if ("delayMs" in policy) {
    const delayMs = clampDelayMs(policy.delayMs);
    if (!policy.jitter) return delayMs;
    return Math.floor(Math.random() * (delayMs + 1));
  }
  const initialDelayMs = clampDelayMs(policy.initialDelayMs);
  const multiplier = Number.isFinite(policy.multiplier ?? 2) ? (policy.multiplier ?? 2) : 2;
  const unbounded = initialDelayMs * multiplier ** Math.max(0, attempt - 1);
  const maxDelayMs = policy.maxDelayMs == null ? unbounded : clampDelayMs(policy.maxDelayMs);
  const delayMs = Math.min(unbounded, maxDelayMs);
  if (!policy.jitter) return delayMs;
  return Math.floor(Math.random() * (delayMs + 1));
}

export function normalizeErrorMessage(error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return errorMessage || "Unknown error";
}

export function extractRetryErrorSignal(error: unknown): RetryErrorSignal {
  const signal: RetryErrorSignal = {};
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 16) {
    const current = queue.shift();
    inspected += 1;
    if (!current) continue;

    if (typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
    }

    const record = asRecord(current);
    if (!record) continue;

    signal.name ??= asString(record.name);
    signal.code ??= asString(record.code);
    signal.status ??= asNumber(record.status);
    signal.statusCode ??= asNumber(record.statusCode);
    signal.responseBody ??= asString(record.responseBody);
    signal.responseHeaders ??= normalizeHeaderRecord(record.responseHeaders);
    signal.retryErrorReason ??= parseRetryErrorReason(record.reason);

    if (typeof record.isRetryable === "boolean" && signal.isRetryable == null) {
      signal.isRetryable = record.isRetryable;
    }

    const dataPayload = parseJsonRecord(record.data);
    if (dataPayload) {
      const nested = getNestedErrorFields(dataPayload);
      signal.providerCode ??= nested.code;
      signal.providerType ??= nested.type;
    }

    const bodyPayload = parseJsonRecord(signal.responseBody);
    if (bodyPayload) {
      const nested = getNestedErrorFields(bodyPayload);
      signal.providerCode ??= nested.code;
      signal.providerType ??= nested.type;
    }

    if ("cause" in record) queue.push(record.cause);
    if ("lastError" in record) queue.push(record.lastError);
    if (Array.isArray(record.errors)) {
      queue.push(...record.errors.slice(0, 4));
    }
  }

  if (signal.providerCode) signal.providerCode = signal.providerCode.toLowerCase();
  if (signal.providerType) signal.providerType = signal.providerType.toLowerCase();
  if (signal.code) signal.code = signal.code.toUpperCase();
  if (signal.name) signal.name = signal.name.toLowerCase();

  return signal;
}

export function extractRetryAfterDelayMs(signal: RetryErrorSignal): number | undefined {
  const headers = signal.responseHeaders;
  if (!headers) return undefined;

  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const parsedMs = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsedMs) && parsedMs >= 0 && parsedMs <= 60_000) {
      return Math.ceil(parsedMs);
    }
  }

  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const parsedSeconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(parsedSeconds)) {
      const delayMs = parsedSeconds * 1000;
      if (delayMs >= 0 && delayMs <= 60_000) {
        return Math.ceil(delayMs);
      }
    }
    const retryAfterDate = Date.parse(retryAfter);
    if (!Number.isNaN(retryAfterDate)) {
      const delayMs = retryAfterDate - Date.now();
      if (delayMs >= 0 && delayMs <= 60_000) {
        return Math.ceil(delayMs);
      }
    }
  }

  return undefined;
}

export function classifyRetryErrorDefault(error: unknown): RetryErrorClassification {
  const signal = extractRetryErrorSignal(error);
  const message = normalizeErrorMessage(error);
  const msg = message.toLowerCase();
  const status = signal.statusCode ?? signal.status ?? parseStatusCodeFromMessage(msg);
  const providerCode = signal.providerCode;

  const isAbortError =
    signal.retryErrorReason === "abort" ||
    signal.name === "aborterror" ||
    signal.name === "responseaborted" ||
    signal.name === "timeouterror" ||
    msg.includes("request was aborted");

  if (isAbortError) {
    return { kind: "unknown", retryable: false, requiresExplicitHandling: false, signal };
  }

  if (providerCode && CONTEXT_OVERFLOW_CODES.has(providerCode)) {
    return { kind: "context_window_exceeded", retryable: false, requiresExplicitHandling: true, signal };
  }
  if (includesAnyPattern(msg, CONTEXT_OVERFLOW_PATTERNS)) {
    return { kind: "context_window_exceeded", retryable: false, requiresExplicitHandling: true, signal };
  }

  if (providerCode && INSUFFICIENT_CREDITS_CODES.has(providerCode)) {
    return { kind: "insufficient_credits", retryable: false, requiresExplicitHandling: true, signal };
  }
  if (includesAnyPattern(msg, INSUFFICIENT_CREDITS_PATTERNS)) {
    return { kind: "insufficient_credits", retryable: false, requiresExplicitHandling: true, signal };
  }

  if (
    status === 401 ||
    status === 403 ||
    (providerCode && AUTH_CODES.has(providerCode)) ||
    includesAnyPattern(msg, AUTH_PATTERNS)
  ) {
    return { kind: "auth", retryable: false, requiresExplicitHandling: true, signal };
  }

  if (
    status === 429 ||
    (providerCode && RATE_LIMIT_CODES.has(providerCode)) ||
    includesAnyPattern(msg, RATE_LIMIT_PATTERNS)
  ) {
    return { kind: "rate_limited", retryable: true, requiresExplicitHandling: false, signal };
  }

  if (status != null && status >= 500 && status <= 599) {
    return { kind: "provider_5xx", retryable: true, requiresExplicitHandling: false, signal };
  }

  if (status === 408 || status === 409) {
    return { kind: "network", retryable: true, requiresExplicitHandling: false, signal };
  }

  if (
    (signal.code && NETWORK_CODES.has(signal.code)) ||
    includesAnyPattern(msg, NETWORK_PATTERNS) ||
    (signal.isRetryable === true && status == null)
  ) {
    return { kind: "network", retryable: true, requiresExplicitHandling: false, signal };
  }

  if (
    status === 400 ||
    status === 422 ||
    (providerCode && INVALID_REQUEST_CODES.has(providerCode)) ||
    includesAnyPattern(msg, INVALID_REQUEST_PATTERNS)
  ) {
    return { kind: "invalid_request", retryable: false, requiresExplicitHandling: true, signal };
  }

  return { kind: "unknown", retryable: false, requiresExplicitHandling: false, signal };
}

export function extractToolErrorInfo(error: unknown): ToolErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const info: ToolErrorInfo = {
    message: message || "Unknown error",
  };

  const root = asRecord(error);
  if (root) {
    info.name = asString(root.name);
    info.code = asString(root.code) ?? asString(root.errno);
    info.status = asNumber(root.status);
    info.statusCode = asNumber(root.statusCode);
    const cause = asRecord(root.cause);
    if (cause) {
      info.causeMessage = asString(cause.message);
      if (!info.code) info.code = asString(cause.code) ?? asString(cause.errno);
      if (info.status == null) info.status = asNumber(cause.status);
      if (info.statusCode == null) info.statusCode = asNumber(cause.statusCode);
    }
  }

  if (info.status == null && info.statusCode == null) {
    const parsedStatus = parseStatusCodeFromMessage(info.message);
    if (parsedStatus != null) {
      info.statusCode = parsedStatus;
    }
  }

  if (info.code) info.code = info.code.toUpperCase();
  return info;
}

export function isRetryableToolErrorDefault(error: ToolErrorInfo | string): boolean {
  const info = typeof error === "string" ? ({ message: error } satisfies ToolErrorInfo) : error;
  const msg = info.message.toLowerCase();
  const status = info.statusCode ?? info.status ?? parseStatusCodeFromMessage(msg);
  const code = info.code?.toUpperCase();
  const hasExplicit5xxStatus = /\bstatus(?:\s+code)?\s*[:=]?\s*5\d{2}\b/.test(msg);

  if (status === 429 || status === 408 || status === 409 || (status != null && status >= 500 && status <= 599)) {
    return true;
  }
  if (status === 401 || status === 403 || (status != null && status >= 400 && status <= 499)) {
    return false;
  }

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "CONNECTIONREFUSED" ||
    code === "CONNECTIONCLOSED" ||
    code === "FAILEDTOOPENSOCKET"
  ) {
    return true;
  }
  if (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("status: 429") ||
    hasExplicit5xxStatus ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway")
  ) {
    return true;
  }
  if (
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("ehostunreach") ||
    msg.includes("connection reset") ||
    msg.includes("connection refused") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("upstream connect") ||
    msg.includes("other side closed") ||
    msg.includes("cannot connect to api")
  ) {
    return true;
  }
  return false;
}

export function isRetryableDecision(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "object" || value === null) return false;
  if (!("retryable" in value)) return false;
  return (value as { retryable?: unknown }).retryable === true;
}
