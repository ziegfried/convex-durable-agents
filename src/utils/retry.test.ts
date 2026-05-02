import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRetryErrorDefault,
  extractRetryAfterDelayMs,
  extractRetryErrorSignal,
  extractToolErrorInfo,
  isRetryableDecision,
  isRetryableToolErrorDefault,
  normalizeErrorMessage,
} from "./retry";

describe("classifyRetryErrorDefault", () => {
  it("classifies rate-limited status as retryable", () => {
    const classification = classifyRetryErrorDefault({ statusCode: 429, message: "Too many requests" });
    expect(classification.kind).toBe("rate_limited");
    expect(classification.retryable).toBe(true);
    expect(classification.requiresExplicitHandling).toBe(false);
  });

  it("classifies provider 5xx as retryable", () => {
    const classification = classifyRetryErrorDefault({ status: 503, message: "Service unavailable" });
    expect(classification.kind).toBe("provider_5xx");
    expect(classification.retryable).toBe(true);
  });

  it("classifies auth failures as explicit handling", () => {
    const classification = classifyRetryErrorDefault({ statusCode: 401, message: "Unauthorized" });
    expect(classification.kind).toBe("auth");
    expect(classification.retryable).toBe(false);
    expect(classification.requiresExplicitHandling).toBe(true);
  });

  it("prefers context-overflow provider code over generic 400", () => {
    const classification = classifyRetryErrorDefault({
      statusCode: 400,
      responseBody: JSON.stringify({ error: { code: "context_length_exceeded" } }),
      message: "Bad request",
    });
    expect(classification.kind).toBe("context_window_exceeded");
    expect(classification.retryable).toBe(false);
    expect(classification.requiresExplicitHandling).toBe(true);
  });

  it("classifies quota provider code as insufficient credits", () => {
    const classification = classifyRetryErrorDefault({
      statusCode: 400,
      data: JSON.stringify({ error: { code: "insufficient_quota" } }),
      message: "quota exceeded",
    });
    expect(classification.kind).toBe("insufficient_credits");
    expect(classification.retryable).toBe(false);
    expect(classification.requiresExplicitHandling).toBe(true);
  });

  it("classifies network system codes as retryable", () => {
    const classification = classifyRetryErrorDefault({ code: "ECONNRESET", message: "socket hang up" });
    expect(classification.kind).toBe("network");
    expect(classification.retryable).toBe(true);
  });

  it("classifies connection/stream termination as retryable network errors", () => {
    const classification = classifyRetryErrorDefault("stream terminated by upstream peer");
    expect(classification.kind).toBe("network");
    expect(classification.retryable).toBe(true);
  });

  it("does not classify unrelated termination text as retryable network errors", () => {
    const classification = classifyRetryErrorDefault("session terminated by administrator");
    expect(classification.kind).toBe("unknown");
    expect(classification.retryable).toBe(false);
  });

  it("classifies retryable unknown status as network", () => {
    const classification = classifyRetryErrorDefault({ isRetryable: true, message: "temporary transport issue" });
    expect(classification.kind).toBe("network");
    expect(classification.retryable).toBe(true);
  });

  it("classifies invalid request status as explicit handling", () => {
    const classification = classifyRetryErrorDefault({ statusCode: 422, message: "Invalid argument" });
    expect(classification.kind).toBe("invalid_request");
    expect(classification.retryable).toBe(false);
    expect(classification.requiresExplicitHandling).toBe(true);
  });

  it("does not retry abort errors", () => {
    const classification = classifyRetryErrorDefault({ reason: "abort", message: "request was aborted" });
    expect(classification.kind).toBe("unknown");
    expect(classification.retryable).toBe(false);
    expect(classification.requiresExplicitHandling).toBe(false);
  });
});

describe("extractRetryErrorSignal", () => {
  it("extracts nested cause fields and normalizes case", () => {
    const signal = extractRetryErrorSignal({
      name: "ApiCallError",
      cause: {
        code: "econnrefused",
        statusCode: 503,
      },
    });

    expect(signal.name).toBe("apicallerror");
    expect(signal.code).toBe("ECONNREFUSED");
    expect(signal.statusCode).toBe(503);
  });
});

describe("extractRetryAfterDelayMs", () => {
  const originalNow = Date.now;

  afterEach(() => {
    Date.now = originalNow;
  });

  it("uses retry-after-ms header when present", () => {
    const delayMs = extractRetryAfterDelayMs({ responseHeaders: { "retry-after-ms": "150.2" } });
    expect(delayMs).toBe(151);
  });

  it("parses retry-after seconds", () => {
    const delayMs = extractRetryAfterDelayMs({ responseHeaders: { "retry-after": "2.4" } });
    expect(delayMs).toBe(2400);
  });

  it("parses retry-after HTTP date", () => {
    Date.now = () => new Date("2026-02-18T00:00:00.000Z").getTime();
    const delayMs = extractRetryAfterDelayMs({
      responseHeaders: { "retry-after": "Wed, 18 Feb 2026 00:00:04 GMT" },
    });
    expect(delayMs).toBe(4000);
  });

  it("ignores values outside cap", () => {
    const delayMs = extractRetryAfterDelayMs({ responseHeaders: { "retry-after": "120" } });
    expect(delayMs).toBeUndefined();
  });
});

describe("normalizeErrorMessage", () => {
  it("normalizes error and non-error values", () => {
    expect(normalizeErrorMessage(new Error("boom"))).toBe("boom");
    expect(normalizeErrorMessage("oops")).toBe("oops");
  });
});

describe("extractToolErrorInfo", () => {
  it("extracts structured fields from root and cause", () => {
    const info = extractToolErrorInfo({
      name: "FetchError",
      message: "request failed",
      cause: {
        code: "etimedout",
        statusCode: 504,
        message: "upstream timed out",
      },
    });

    expect(info.name).toBe("FetchError");
    expect(info.code).toBe("ETIMEDOUT");
    expect(info.statusCode).toBe(504);
    expect(info.causeMessage).toBe("upstream timed out");
  });

  it("parses status code from message when missing", () => {
    const info = extractToolErrorInfo(new Error("status code: 503 from provider"));
    expect(info.statusCode).toBe(503);
  });
});

describe("isRetryableToolErrorDefault", () => {
  it("retries retryable status codes", () => {
    expect(isRetryableToolErrorDefault({ message: "busy", statusCode: 429 })).toBe(true);
    expect(isRetryableToolErrorDefault({ message: "timeout", statusCode: 408 })).toBe(true);
    expect(isRetryableToolErrorDefault({ message: "server", statusCode: 503 })).toBe(true);
  });

  it("does not retry non-retryable status codes", () => {
    expect(isRetryableToolErrorDefault({ message: "unauthorized", statusCode: 401 })).toBe(false);
    expect(isRetryableToolErrorDefault({ message: "validation", statusCode: 422 })).toBe(false);
  });

  it("retries network/system error codes", () => {
    expect(isRetryableToolErrorDefault({ message: "socket error", code: "ECONNRESET" })).toBe(true);
    expect(isRetryableToolErrorDefault({ message: "dns", code: "ENOTFOUND" })).toBe(true);
  });

  it("retries known transient messages", () => {
    expect(isRetryableToolErrorDefault("fetch failed due to upstream connect error")).toBe(true);
  });

  it("does not treat non-http 'status: 5' text as retryable", () => {
    expect(isRetryableToolErrorDefault("processing status: 5 items remaining")).toBe(false);
  });

  it("does not retry unknown deterministic errors", () => {
    expect(isRetryableToolErrorDefault("invalid input: account id is required")).toBe(false);
  });
});

describe("isRetryableDecision", () => {
  it("accepts supported retry decision shapes", () => {
    expect(isRetryableDecision(true)).toBe(true);
    expect(isRetryableDecision({ retryable: true })).toBe(true);
  });

  it("rejects unsupported decision values", () => {
    expect(isRetryableDecision(false)).toBe(false);
    expect(isRetryableDecision({ retryable: false })).toBe(false);
    expect(isRetryableDecision({})).toBe(false);
    expect(isRetryableDecision(null)).toBe(false);
  });
});
