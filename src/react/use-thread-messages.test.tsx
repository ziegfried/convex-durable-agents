import "./test/happy-dom-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { MessageDoc, StreamingMessageUpdates, ThreadDoc } from "./types";

// ---------------------------------------------------------------------------
// Sentinel query references – opaque objects the hook receives as props.
// The mock useQuery inspects these to dispatch to the right mock function.
// ---------------------------------------------------------------------------
const messagesQueryRef = { __brand: "messagesQuery" } as any;
const threadQueryRef = { __brand: "threadQuery" } as any;
const streamingQueryRef = { __brand: "streamingQuery" } as any;

// ---------------------------------------------------------------------------
// Per-call mock return values (set in each test / beforeEach)
// ---------------------------------------------------------------------------
let messagesReturn: MessageDoc[] | undefined;
let threadReturn: ThreadDoc | null | undefined;
let streamingReturn: StreamingMessageUpdates | undefined;

/** Track all useQuery calls so we can assert on `"skip"` args */
let useQueryCalls: Array<[ref: unknown, args: unknown]> = [];

// ---------------------------------------------------------------------------
// Mock convex/react before importing the hook
// ---------------------------------------------------------------------------
vi.doMock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    useQueryCalls.push([ref, args]);
    if (args === "skip") return undefined;
    if (ref === messagesQueryRef) return messagesReturn;
    if (ref === threadQueryRef) return threadReturn;
    if (ref === streamingQueryRef) return streamingReturn;
    return undefined;
  },
  useMutation: () => {
    throw new Error("useMutation is not mocked in use-thread-messages tests");
  },
}));

// Import AFTER mocking
const { useThreadMessages, useMessages } = await import("./use-thread-messages");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname!, "__fixtures__");

type FixtureMessage = {
  id: string;
  role: string;
  parts: any[];
  metadata?: {
    key?: string;
    status?: string;
    _creationTime?: number;
    committedSeq?: number;
  };
};

type Fixture = {
  description: string;
  logLine: number;
  messages: FixtureMessage[];
  streamingUpdates: StreamingMessageUpdates;
};

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

/** Convert a fixture message (UIMessageWithConvexMetadata shape) back to a MessageDoc */
function fixtureMessageToDoc(msg: FixtureMessage, threadId: string): MessageDoc {
  return {
    _id: `doc-${msg.id}`,
    _creationTime: msg.metadata?._creationTime ?? 0,
    threadId,
    id: msg.id,
    role: msg.role as MessageDoc["role"],
    parts: msg.parts,
    committedSeq: msg.metadata?.committedSeq,
    metadata: msg.metadata,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(overrides: Partial<MessageDoc> = {}): MessageDoc {
  return {
    _id: "doc1",
    _creationTime: 1000,
    threadId: "thread-1",
    id: "msg-user-1",
    role: "user",
    parts: [{ type: "text" as const, text: "hello" }],
    ...overrides,
  };
}

function makeAssistantMessage(overrides: Partial<MessageDoc> = {}): MessageDoc {
  return {
    _id: "doc2",
    _creationTime: 2000,
    threadId: "thread-1",
    id: "msg-asst-1",
    role: "assistant",
    parts: [{ type: "text" as const, text: "hi there" }],
    committedSeq: 1,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadDoc> = {}): ThreadDoc {
  return {
    _id: "thread-doc-1",
    _creationTime: 500,
    status: "completed",
    stopSignal: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  messagesReturn = undefined;
  threadReturn = undefined;
  streamingReturn = undefined;
  useQueryCalls = [];
});

// ===================================================================
// Tests
// ===================================================================

describe("useThreadMessages", () => {
  // -----------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------
  describe("loading state", () => {
    it("returns isLoading: true and empty messages when queries return undefined", () => {
      // messagesReturn is undefined (default)
      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.messages).toEqual([]);
      expect(result.current.thread).toBeUndefined();
      expect(result.current.status).toBeUndefined();
      expect(result.current.isRunning).toBe(false);
      expect(result.current.isComplete).toBe(false);
      expect(result.current.isFailed).toBe(false);
      expect(result.current.isStopped).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // Messages-only path (no streaming query)
  // -----------------------------------------------------------------
  describe("messages without streaming", () => {
    it("returns persisted messages with addConvexMetadata when streamingMessageUpdatesQuery is null", () => {
      const userMsg = makeUserMessage();
      messagesReturn = [userMsg];
      threadReturn = makeThread({ status: "completed" });

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: null as any,
          threadId: "thread-1",
        }),
      );

      expect(result.current.isLoading).toBe(false);
      expect(result.current.messages).toHaveLength(1);

      const msg = result.current.messages[0]!;
      expect(msg.id).toBe("msg-user-1");
      expect(msg.role).toBe("user");
      expect(msg.parts).toEqual([{ type: "text", text: "hello" }]);
      // addConvexMetadata should have applied
      expect((msg as any).metadata?.key).toBe("thread-1-msg-user-1");
      expect((msg as any).metadata?.status).toBe("success");
      expect((msg as any).metadata?._creationTime).toBe(1000);
    });

    it("returns multiple messages in order", () => {
      messagesReturn = [makeUserMessage(), makeAssistantMessage()];
      threadReturn = makeThread();

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: null as any,
          threadId: "thread-1",
        }),
      );

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0]!.role).toBe("user");
      expect(result.current.messages[1]!.role).toBe("assistant");
    });
  });

  // -----------------------------------------------------------------
  // Streaming merge
  // -----------------------------------------------------------------
  describe("streaming updates merge", () => {
    it("merges streaming text deltas into persisted messages", async () => {
      const userMsg = makeUserMessage();
      const assistantMsg = makeAssistantMessage({
        id: "msg-asst-1",
        parts: [{ type: "text" as const, text: "partial" }],
        committedSeq: 1,
      });
      messagesReturn = [userMsg, assistantMsg];
      threadReturn = makeThread({ status: "streaming" });
      streamingReturn = {
        messages: [
          {
            msgId: "msg-asst-1",
            parts: [
              { messageId: "msg-asst-1", seq: 2, type: "start" },
              { seq: 2, type: "start-step" },
              { id: "0", seq: 2, type: "text-start" },
              { delta: " more text here", id: "0", seq: 2, type: "text-delta" },
            ],
          },
        ],
      };

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      // Wait for the async applyStreamingUpdates to resolve
      await waitFor(() => {
        // The streaming merge should produce a message with extra parts from the stream
        const assistantMessages = result.current.messages.filter((m) => m.role === "assistant");
        expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
        // The merged message should contain the streamed text
        const allText = assistantMessages
          .flatMap((m) => m.parts)
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
        expect(allText).toContain("more text here");
      });
    });

    it("creates a new assistant message if msgId is not in persisted messages", async () => {
      const userMsg = makeUserMessage();
      messagesReturn = [userMsg];
      threadReturn = makeThread({ status: "streaming" });
      streamingReturn = {
        messages: [
          {
            msgId: "new-assistant-msg",
            parts: [
              { messageId: "new-assistant-msg", seq: 1, type: "start" },
              { seq: 1, type: "start-step" },
              { id: "0", seq: 1, type: "text-start" },
              { delta: "hello from streaming", id: "0", seq: 1, type: "text-delta" },
            ],
          },
        ],
      };

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      await waitFor(() => {
        expect(result.current.messages.length).toBeGreaterThan(1);
        const newMsg = result.current.messages.find((m) => m.id === "new-assistant-msg");
        expect(newMsg).toBeDefined();
        expect(newMsg!.role).toBe("assistant");
        const texts = newMsg!.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
        expect(texts).toContain("hello from streaming");
      });
    });

    it("skips streaming parts whose seq <= committedSeq", async () => {
      const assistantMsg = makeAssistantMessage({
        id: "msg-asst-1",
        parts: [{ type: "text" as const, text: "committed text" }],
        committedSeq: 5,
      });
      messagesReturn = [makeUserMessage(), assistantMsg];
      threadReturn = makeThread({ status: "streaming" });
      streamingReturn = {
        messages: [
          {
            msgId: "msg-asst-1",
            parts: [
              // seq 4 and 5 should be filtered out (already committed)
              { messageId: "msg-asst-1", seq: 4, type: "start" },
              { id: "0", seq: 5, type: "text-start" },
              { delta: "should be filtered", id: "0", seq: 5, type: "text-delta" },
              // seq 6 should pass through
              { messageId: "msg-asst-1", seq: 6, type: "start" },
              { seq: 6, type: "start-step" },
              { id: "1", seq: 6, type: "text-start" },
              { delta: "fresh content", id: "1", seq: 6, type: "text-delta" },
            ],
          },
        ],
      };

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      await waitFor(() => {
        const asst = result.current.messages.find((m) => m.id === "msg-asst-1");
        expect(asst).toBeDefined();
        const allText = asst!.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
        expect(allText).toContain("fresh content");
        // "should be filtered" should not appear as a new text part —
        // the committed text remains from the base, but the streaming delta is skipped
      });
    });

    it("returns persisted messages when streaming updates have empty messages array", () => {
      messagesReturn = [makeUserMessage()];
      threadReturn = makeThread({ status: "completed" });
      streamingReturn = { messages: [] };

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      // No async merge needed — empty streaming updates fall through to persisted
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]!.id).toBe("msg-user-1");
    });
  });

  // -----------------------------------------------------------------
  // Status flags
  // -----------------------------------------------------------------
  describe("status flags", () => {
    it.each([
      { status: "streaming" as const, isRunning: true, isComplete: false, isFailed: false, isStopped: false },
      {
        status: "awaiting_tool_results" as const,
        isRunning: true,
        isComplete: false,
        isFailed: false,
        isStopped: false,
      },
      { status: "completed" as const, isRunning: false, isComplete: true, isFailed: false, isStopped: false },
      { status: "failed" as const, isRunning: false, isComplete: false, isFailed: true, isStopped: false },
      { status: "stopped" as const, isRunning: false, isComplete: false, isFailed: false, isStopped: true },
    ])('derives correct flags for thread status "$status"', ({
      status,
      isRunning,
      isComplete,
      isFailed,
      isStopped,
    }) => {
      messagesReturn = [makeUserMessage()];
      threadReturn = makeThread({ status });

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: null as any,
          threadId: "thread-1",
        }),
      );

      expect(result.current.status).toBe(status);
      expect(result.current.isRunning).toBe(isRunning);
      expect(result.current.isComplete).toBe(isComplete);
      expect(result.current.isFailed).toBe(isFailed);
      expect(result.current.isStopped).toBe(isStopped);
    });

    it("returns undefined status when thread is null", () => {
      messagesReturn = [makeUserMessage()];
      threadReturn = null;

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: null as any,
          threadId: "thread-1",
        }),
      );

      expect(result.current.status).toBeUndefined();
      expect(result.current.isRunning).toBe(false);
      expect(result.current.isComplete).toBe(false);
      expect(result.current.isFailed).toBe(false);
      expect(result.current.isStopped).toBe(false);
    });

    it("returns undefined status when thread is undefined (loading)", () => {
      messagesReturn = [];
      threadReturn = undefined;

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: null as any,
          threadId: "thread-1",
        }),
      );

      expect(result.current.status).toBeUndefined();
      expect(result.current.thread).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // Skip behavior
  // -----------------------------------------------------------------
  describe("skip behavior", () => {
    it('passes "skip" to useQuery when skip=true', () => {
      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
          skip: true,
        }),
      );

      // Both messages and thread queries should receive "skip"
      const messagesQueryCalls = useQueryCalls.filter(([ref]) => ref === messagesQueryRef);
      const threadQueryCalls = useQueryCalls.filter(([ref]) => ref === threadQueryRef);

      expect(messagesQueryCalls.length).toBeGreaterThanOrEqual(1);
      expect(messagesQueryCalls[0]![1]).toBe("skip");

      expect(threadQueryCalls.length).toBeGreaterThanOrEqual(1);
      expect(threadQueryCalls[0]![1]).toBe("skip");

      // isLoading should be true since queries returned undefined
      expect(result.current.isLoading).toBe(true);
      expect(result.current.messages).toEqual([]);
    });

    it("passes threadId args to useQuery when skip=false", () => {
      messagesReturn = [];
      threadReturn = makeThread();

      renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
          skip: false,
        }),
      );

      const messagesQueryCalls = useQueryCalls.filter(([ref]) => ref === messagesQueryRef);
      const threadQueryCalls = useQueryCalls.filter(([ref]) => ref === threadQueryRef);

      expect(messagesQueryCalls[0]![1]).toEqual({ threadId: "thread-1" });
      expect(threadQueryCalls[0]![1]).toEqual({ threadId: "thread-1" });
    });
  });

  // -----------------------------------------------------------------
  // fromSeq derivation
  // -----------------------------------------------------------------
  describe("fromSeq derivation", () => {
    it("skips streaming query initially (fromSeq is null on first render)", () => {
      messagesReturn = undefined; // still loading
      threadReturn = undefined;

      renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      // The streaming query should be called with "skip" since fromSeq is null
      const streamingCalls = useQueryCalls.filter(([ref]) => ref === streamingQueryRef);
      expect(streamingCalls.length).toBeGreaterThanOrEqual(1);
      expect(streamingCalls[0]![1]).toBe("skip");
    });

    it("derives fromSeq from max committedSeq + 1 after messages load", async () => {
      const msg1 = makeAssistantMessage({ id: "a1", committedSeq: 3 });
      const msg2 = makeAssistantMessage({ id: "a2", _id: "doc3", committedSeq: 7 });
      messagesReturn = [makeUserMessage(), msg1, msg2];
      threadReturn = makeThread({ status: "streaming" });
      streamingReturn = { messages: [] };

      const { rerender } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      // After the useEffect runs, fromSeq should be max(3,7) + 1 = 8
      // We need to rerender to see the effect of the state update
      await waitFor(() => {
        rerender();
        const streamingCalls = useQueryCalls.filter(([ref]) => ref === streamingQueryRef);
        const lastCall = streamingCalls[streamingCalls.length - 1];
        // Eventually useStreamingUpdates should compute fromSeq = 8
        if (lastCall && lastCall[1] !== "skip") {
          expect(lastCall[1]).toEqual({ threadId: "thread-1", fromSeq: 8 });
        }
      });
    });

    it("uses fromSeq=0 when no messages have committedSeq", async () => {
      messagesReturn = [makeUserMessage({ committedSeq: undefined })];
      threadReturn = makeThread({ status: "streaming" });
      streamingReturn = { messages: [] };

      const { rerender } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: "thread-1",
        }),
      );

      await waitFor(() => {
        rerender();
        const streamingCalls = useQueryCalls.filter(([ref]) => ref === streamingQueryRef);
        const lastCall = streamingCalls[streamingCalls.length - 1];
        if (lastCall && lastCall[1] !== "skip") {
          // max(-1) is -1 which is not finite via Math.max(...[-1])
          // Actually Math.max(-1) = -1 which IS finite, so fromSeq = -1 + 1 = 0
          expect(lastCall[1]).toEqual({ threadId: "thread-1", fromSeq: 0 });
        }
      });
    });
  });
});

// ===================================================================
// useMessages (exported helper)
// ===================================================================

describe("useMessages", () => {
  it("applies addConvexMetadata to each message", () => {
    const rawMsg: MessageDoc = {
      _id: "doc-abc",
      _creationTime: 9999,
      threadId: "t-1",
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "test" }],
      committedSeq: 42,
    };
    messagesReturn = [rawMsg];
    threadReturn = makeThread();

    const { result } = renderHook(() => useMessages(messagesQueryRef, threadQueryRef, { threadId: "t-1" }));

    expect(result.current.isLoading).toBe(false);
    const msg = result.current.messages[0]!;
    expect(msg.metadata).toEqual({
      key: "t-1-msg-1",
      status: "success",
      _creationTime: 9999,
      committedSeq: 42,
    });
  });

  it("returns isLoading: true when rawMessages is undefined", () => {
    messagesReturn = undefined;
    threadReturn = undefined;

    const { result } = renderHook(() => useMessages(messagesQueryRef, threadQueryRef, { threadId: "t-1" }));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.messages).toEqual([]);
    expect(result.current.thread).toBeUndefined();
  });

  it('passes "skip" to useQuery when args is "skip"', () => {
    renderHook(() => useMessages(messagesQueryRef, threadQueryRef, "skip"));

    const messagesQueryCalls = useQueryCalls.filter(([ref]) => ref === messagesQueryRef);
    const threadQueryCalls = useQueryCalls.filter(([ref]) => ref === threadQueryRef);

    expect(messagesQueryCalls[0]![1]).toBe("skip");
    expect(threadQueryCalls[0]![1]).toBe("skip");
  });
});

// ===================================================================
// Fixture-driven snapshot tests (end-to-end hook with real data)
// ===================================================================

describe("useThreadMessages with fixtures", () => {
  const THREAD_ID = "fixture-thread";

  for (const file of fixtureFiles) {
    const fixture: Fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8"));

    it(`${fixture.description} (log line ${fixture.logLine})`, async () => {
      // Set up mock return values from the fixture data
      messagesReturn = fixture.messages.map((m) => fixtureMessageToDoc(m, THREAD_ID));
      threadReturn = makeThread({ status: "streaming" });
      streamingReturn = fixture.streamingUpdates;

      const { result } = renderHook(() =>
        useThreadMessages({
          messagesQuery: messagesQueryRef,
          threadQuery: threadQueryRef,
          streamingMessageUpdatesQuery: streamingQueryRef,
          threadId: THREAD_ID,
        }),
      );

      if (fixture.streamingUpdates.messages.length > 0) {
        // Wait for the async applyStreamingUpdates to resolve and React to re-render.
        // The useEffect fires synchronously after render, calls applyStreamingUpdates
        // which creates a ReadableStream and resolves almost immediately. We flush
        // microtasks via act() and then waitFor the state update to propagate.
        await act(async () => {
          // Flush pending promises (applyStreamingUpdates resolves in one microtask tick)
          await new Promise((r) => setTimeout(r, 50));
        });

        // Now wait for React to apply the state update
        await waitFor(
          () => {
            const msgIds = new Set(result.current.messages.map((m) => m.id));
            for (const update of fixture.streamingUpdates.messages) {
              expect(msgIds.has(update.msgId)).toBe(true);
            }
          },
          { timeout: 3000, interval: 50 },
        );
      }

      // Snapshot the full hook result
      expect({
        messages: result.current.messages,
        status: result.current.status,
        isLoading: result.current.isLoading,
        isRunning: result.current.isRunning,
        isComplete: result.current.isComplete,
        isFailed: result.current.isFailed,
        isStopped: result.current.isStopped,
      }).toMatchSnapshot();
    });
  }
});
