import { describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import { joinAdjacentDeltas, Streamer } from "./streamer.js";

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

describe("joinAdjacentDeltas", () => {
  it("returns empty array for empty input", () => {
    expect(joinAdjacentDeltas([])).toEqual([]);
  });

  it("joins adjacent text-delta chunks with the same id", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "a", delta: " world" },
      { type: "text-delta", id: "a", delta: "!" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([{ type: "text-delta", id: "a", delta: "Hello world!" }]);
  });

  it("joins adjacent reasoning-delta chunks with the same id", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "reasoning-delta", id: "r1", delta: "Let me " },
      { type: "reasoning-delta", id: "r1", delta: "think" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([{ type: "reasoning-delta", id: "r1", delta: "Let me think" }]);
  });

  it("does not join text-delta chunks with different ids", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "b", delta: " world" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "b", delta: " world" },
    ]);
  });

  it("does not join text-delta and reasoning-delta even with same id", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "reasoning-delta", id: "a", delta: "think" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "reasoning-delta", id: "a", delta: "think" },
    ]);
  });

  it("does not join non-adjacent same-type chunks", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "a", delta: " world" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "a", delta: " world" },
    ]);
  });

  it("passes through non-delta chunk types unchanged", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-start", id: "a" },
      { type: "text-end", id: "a" },
      { type: "start" },
      { type: "finish" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual(chunks);
  });

  it("handles mixed delta and non-delta chunks", () => {
    const chunks: Array<UIMessageChunk> = [
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-delta", id: "a", delta: " world" },
      { type: "text-end", id: "a" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Step " },
      { type: "reasoning-delta", id: "r1", delta: "1" },
    ];
    expect(joinAdjacentDeltas(chunks)).toEqual([
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hello world" },
      { type: "text-end", id: "a" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Step 1" },
    ]);
  });

  it("handles a single chunk", () => {
    const chunks: Array<UIMessageChunk> = [{ type: "text-delta", id: "a", delta: "Hello" }];
    expect(joinAdjacentDeltas(chunks)).toEqual([{ type: "text-delta", id: "a", delta: "Hello" }]);
  });
});
