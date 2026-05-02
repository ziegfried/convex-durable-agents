import "./test/happy-dom-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MessageDoc, ThreadDoc } from "./types";

const listMessagesQueryRef = { __brand: "listMessagesQuery" } as any;
const streamUpdatesQueryRef = { __brand: "streamUpdatesQuery" } as any;
const getThreadQueryRef = { __brand: "getThreadQuery" } as any;
const sendMutationRef = { __brand: "sendMutation" } as any;
const stopMutationRef = { __brand: "stopMutation" } as any;
const resumeMutationRef = { __brand: "resumeMutation" } as any;

let messagesReturn: MessageDoc[] | undefined;
let threadReturn: ThreadDoc | null | undefined;
let sendMutationCalls: Array<{ prompt: string; threadId: string }> = [];
let sendMutationImpl: (args: { prompt: string; threadId: string }) => Promise<null>;
let stopMutationImpl: (args: { threadId: string }) => Promise<null>;
let resumeMutationImpl: (args: { threadId: string; prompt?: string }) => Promise<null>;
type SendOptimisticUpdate = (localStore: any, args: { prompt: string; threadId: string }) => void;
let capturedOptimisticUpdate: SendOptimisticUpdate | undefined;

vi.doMock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === listMessagesQueryRef) return messagesReturn;
    if (ref === getThreadQueryRef) return threadReturn;
    if (ref === streamUpdatesQueryRef) return undefined;
    return undefined;
  },
  useMutation: (ref: unknown) => {
    if (ref === sendMutationRef) {
      const mutation = (async (args: { prompt: string; threadId: string }) => {
        sendMutationCalls.push(args);
        return sendMutationImpl(args);
      }) as ((args: { prompt: string; threadId: string }) => Promise<null>) & {
        withOptimisticUpdate: (update: SendOptimisticUpdate) => typeof mutation;
      };
      mutation.withOptimisticUpdate = (update: SendOptimisticUpdate) => {
        capturedOptimisticUpdate = update;
        return mutation;
      };
      return mutation;
    }
    if (ref === stopMutationRef) {
      return stopMutationImpl;
    }
    if (ref === resumeMutationRef) {
      return resumeMutationImpl;
    }
    throw new Error("Unknown mutation reference");
  },
}));

const { useAgentChat } = await import("./agent-chat");

function makeUserDoc(id: string, text: string): MessageDoc {
  return {
    _id: `doc-${id}`,
    _creationTime: 1,
    threadId: "thread-1",
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

beforeEach(() => {
  messagesReturn = [];
  threadReturn = { _id: "thread-doc-1", _creationTime: 500, status: "completed", stopSignal: false };
  sendMutationCalls = [];
  sendMutationImpl = async () => null;
  stopMutationImpl = async () => null;
  resumeMutationImpl = async () => null;
  capturedOptimisticUpdate = undefined;
});

describe("useAgentChat optimistic updates", () => {
  const options = {
    listMessages: listMessagesQueryRef,
    streamUpdates: streamUpdatesQueryRef,
    getThread: getThreadQueryRef,
    sendMessage: sendMutationRef,
    stopThread: stopMutationRef,
    resumeThread: resumeMutationRef,
    threadId: "thread-1",
  };

  it("pre-binds threadId for sendMessage", async () => {
    const { result } = renderHook(() => useAgentChat(options));

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(sendMutationCalls).toEqual([{ threadId: "thread-1", prompt: "hello" }]);
  });

  it("registers an optimistic updater that appends a user message", () => {
    renderHook(() => useAgentChat(options));
    expect(capturedOptimisticUpdate).toBeDefined();

    let queryValue: MessageDoc[] | undefined = [makeUserDoc("existing", "existing prompt")];
    let setQueryValue: MessageDoc[] | undefined;
    let setQueryArgs: { threadId: string } | undefined;

    capturedOptimisticUpdate!(
      {
        getAllQueries: () => [],
        getQuery: (_query: unknown, args: unknown) => {
          expect(_query).toBe(listMessagesQueryRef);
          expect(args).toEqual({ threadId: "thread-1" });
          return queryValue;
        },
        setQuery: (_query: unknown, args: unknown, value: unknown) => {
          expect(_query).toBe(listMessagesQueryRef);
          setQueryArgs = args as { threadId: string };
          setQueryValue = value as MessageDoc[] | undefined;
          queryValue = value as MessageDoc[] | undefined;
        },
      },
      { threadId: "thread-1", prompt: "new prompt" },
    );

    expect(setQueryArgs).toEqual({ threadId: "thread-1" });
    expect(setQueryValue).toBeDefined();
    expect(setQueryValue).toHaveLength(2);
    const optimisticMessage = setQueryValue![1]!;
    expect(optimisticMessage.role).toBe("user");
    expect(optimisticMessage.threadId).toBe("thread-1");
    expect(optimisticMessage.id.startsWith("optimistic-")).toBe(true);
    expect(optimisticMessage.parts).toEqual([{ type: "text", text: "new prompt" }]);
  });

  it("seeds query with optimistic message when list query has not loaded", () => {
    renderHook(() => useAgentChat(options));
    expect(capturedOptimisticUpdate).toBeDefined();

    let setQueryValue: MessageDoc[] | undefined;

    capturedOptimisticUpdate!(
      {
        getAllQueries: () => [],
        getQuery: () => undefined,
        setQuery: (_query: unknown, _args: unknown, value: unknown) => {
          setQueryValue = value as MessageDoc[] | undefined;
        },
      },
      { threadId: "thread-1", prompt: "first message" },
    );

    expect(setQueryValue).toBeDefined();
    expect(setQueryValue).toHaveLength(1);
    expect(setQueryValue![0]!.parts).toEqual([{ type: "text", text: "first message" }]);
  });
});
