import { describe, expect, it, vi } from "vitest";
import { Streamer } from "./streamer.js";

/**
 * Minimal mocks for testing the Streamer in isolation.
 * We only need the mutation calls the Streamer makes.
 */
function createMockCtx() {
  return {
    runQuery: vi.fn().mockResolvedValue(null),
    runMutation: vi.fn().mockResolvedValue(null),
    runAction: vi.fn().mockResolvedValue(null),
    storage: {} as any,
    auth: {} as any,
    scheduler: { runAfter: vi.fn() } as any,
  };
}

function createMockComponent() {
  return {
    streams: {
      take: "streams:take" as any,
      addDelta: "streams:addDelta" as any,
      finish: "streams:finish" as any,
      abort: "streams:abort" as any,
      heartbeat: "streams:heartbeat" as any,
    },
  } as any;
}

function createStreamer(ctx = createMockCtx(), component = createMockComponent()) {
  const streamer = new Streamer(component, ctx, {
    throttleMs: 50,
    heartbeatMs: 60_000,
    lockId: "test-lock",
    threadId: "test-thread" as any,
    streamId: "test-stream" as any,
    includeToolInputDeltas: false,
  });
  return { streamer, ctx, component };
}

describe("Streamer", () => {
  describe("fail() cancels pending flush timeout", () => {
    it("should not write deltas after fail() is called", async () => {
      const { streamer, ctx } = createStreamer();
      streamer.enableDeltaStreaming();
      await streamer.setMessageId("msg-1", false);

      // Queue some parts via process() — this schedules a throttled flush
      await streamer.process({ type: "text-delta" as any, id: "t1", delta: "hello " });
      await streamer.process({ type: "text-delta" as any, id: "t1", delta: "world" });

      // Now call fail() — this should cancel the pending flush
      await streamer.fail("Provider connection lost");

      // Verify abort was called
      expect(ctx.runMutation).toHaveBeenCalledWith("streams:abort", {
        streamId: "test-stream",
        reason: "Provider connection lost",
      });

      // Wait longer than the throttle interval to give the (cancelled) timeout
      // a chance to fire if it wasn't properly cancelled
      await new Promise((resolve) => setTimeout(resolve, 150));

      // addDelta should NEVER have been called — the flush was cancelled
      const addDeltaCalls = ctx.runMutation.mock.calls.filter(
        (call) => call[0] === "streams:addDelta",
      );
      expect(addDeltaCalls).toHaveLength(0);
    });

    it("should still flush deltas on finish() (happy path)", async () => {
      const { streamer, ctx } = createStreamer();
      streamer.enableDeltaStreaming();
      await streamer.setMessageId("msg-1", false);

      await streamer.process({ type: "text-delta" as any, id: "t1", delta: "hello" });

      await streamer.finish();

      // finish() should flush remaining deltas then mark stream finished
      const addDeltaCalls = ctx.runMutation.mock.calls.filter(
        (call) => call[0] === "streams:addDelta",
      );
      expect(addDeltaCalls).toHaveLength(1);

      expect(ctx.runMutation).toHaveBeenCalledWith("streams:finish", {
        streamId: "test-stream",
      });
    });
  });
});
