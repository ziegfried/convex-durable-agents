import { describe, expect, it } from "vitest";
import type { FunctionReference } from "convex/server";
import { z } from "zod";
import { createActionTool } from "./tools";

const fakeHandler = "internal:fake.handler" as unknown as FunctionReference<"action", "internal" | "public">;

describe("createActionTool", () => {
  it("normalizes retry=true into enabled retry policy", () => {
    const tool = createActionTool({
      description: "test",
      args: z.object({ value: z.string() }),
      handler: fakeHandler,
      retry: true,
    });

    expect(tool.retry).toEqual({ enabled: true });
  });

  it("preserves custom retry policy", () => {
    const tool = createActionTool({
      description: "test",
      args: z.object({ value: z.string() }),
      handler: fakeHandler,
      retry: {
        enabled: true,
        maxAttempts: 5,
        backoff: { strategy: "fixed", delayMs: 250, jitter: false },
      },
    });

    expect(tool.retry).toEqual({
      enabled: true,
      maxAttempts: 5,
      backoff: { strategy: "fixed", delayMs: 250, jitter: false },
    });
  });

  it("omits retry policy when not provided", () => {
    const tool = createActionTool({
      description: "test",
      args: z.object({ value: z.string() }),
      handler: fakeHandler,
    });

    expect(tool.retry).toBeUndefined();
  });
});
