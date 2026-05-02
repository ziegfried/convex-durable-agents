import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import { STREAM_HEARTBEAT_INTERVAL_MS, STREAM_LIVENESS_THRESHOLD_MS } from "../utils/streaming";
import { isAlive, replacePartIds } from "./streams";

describe("isAlive", () => {
  it("uses a liveness threshold greater than the heartbeat interval", () => {
    expect(STREAM_LIVENESS_THRESHOLD_MS).toBeGreaterThan(STREAM_HEARTBEAT_INTERVAL_MS);
  });

  it("returns true for a recent streaming heartbeat", () => {
    const stream = {
      state: {
        kind: "streaming",
        lockId: "lock-id",
        lastHeartbeat: Date.now(),
      },
    } as Exclude<Parameters<typeof isAlive>[0], null>;
    expect(isAlive(stream)).toBe(true);
  });

  it("returns false for an old streaming heartbeat", () => {
    const stream = {
      state: {
        kind: "streaming",
        lockId: "lock-id",
        lastHeartbeat: Date.now() - STREAM_LIVENESS_THRESHOLD_MS - 1,
      },
    } as Exclude<Parameters<typeof isAlive>[0], null>;
    expect(isAlive(stream)).toBe(false);
  });
});

describe("replacePartIds", () => {
  it("returns empty array for empty input", () => {
    expect(replacePartIds([], new Map(), new Set())).toEqual([]);
  });

  it("assigns sequential ids starting from 0", () => {
    const parts: UIMessageChunk[] = [
      { type: "text-delta", id: "orig-a", delta: "Hello" },
      { type: "text-delta", id: "orig-b", delta: " world" },
    ];
    const result = replacePartIds(parts, new Map(), new Set());
    expect(result).toEqual([
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-delta", id: "1", delta: " world" },
    ]);
  });

  it("reuses mapped id for parts with the same original id", () => {
    const parts: UIMessageChunk[] = [
      { type: "text-delta", id: "orig-a", delta: "Hello" },
      { type: "text-delta", id: "orig-a", delta: " again" },
    ];
    const result = replacePartIds(parts, new Map(), new Set());
    expect(result).toEqual([
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-delta", id: "0", delta: " again" },
    ]);
  });

  it("uses pre-existing newIds mapping", () => {
    const newIds = new Map([["orig-a", "42"]]);
    const parts: UIMessageChunk[] = [{ type: "text-delta", id: "orig-a", delta: "Hello" }];
    const result = replacePartIds(parts, newIds, new Set());
    expect(result).toEqual([{ type: "text-delta", id: "42", delta: "Hello" }]);
  });

  it("skips ids that are already in prevIds", () => {
    const prevIds = new Set(["0", "1"]);
    const parts: UIMessageChunk[] = [{ type: "text-delta", id: "orig-a", delta: "Hello" }];
    const result = replacePartIds(parts, new Map(), prevIds);
    expect(result).toEqual([{ type: "text-delta", id: "2", delta: "Hello" }]);
  });

  it("adds generated ids to prevIds", () => {
    const prevIds = new Set<string>();
    const parts: UIMessageChunk[] = [{ type: "text-delta", id: "orig-a", delta: "Hello" }];
    replacePartIds(parts, new Map(), prevIds);
    expect(prevIds.has("0")).toBe(true);
  });

  it("records new mappings in newIds", () => {
    const newIds = new Map<string, string>();
    const parts: UIMessageChunk[] = [{ type: "text-delta", id: "orig-a", delta: "Hello" }];
    replacePartIds(parts, newIds, new Set());
    expect(newIds.get("orig-a")).toBe("0");
  });

  it("passes through parts without an id field unchanged", () => {
    const parts: UIMessageChunk[] = [{ type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "some input" }];
    const result = replacePartIds(parts, new Map(), new Set());
    expect(result).toEqual([{ type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "some input" }]);
  });

  it("passes through parts with a falsy id unchanged", () => {
    const parts: UIMessageChunk[] = [{ type: "text-delta", id: "", delta: "Hello" }];
    const result = replacePartIds(parts, new Map(), new Set());
    expect(result).toEqual([{ type: "text-delta", id: "", delta: "Hello" }]);
  });

  it("handles a mix of parts with and without ids", () => {
    const parts: UIMessageChunk[] = [
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "input" },
      { type: "reasoning-delta", id: "b", delta: "thinking" },
      { type: "text-delta", id: "a", delta: " world" },
    ];
    const result = replacePartIds(parts, new Map(), new Set());
    expect(result).toEqual([
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "input" },
      { type: "reasoning-delta", id: "1", delta: "thinking" },
      { type: "text-delta", id: "0", delta: " world" },
    ]);
  });
});
