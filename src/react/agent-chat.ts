import { useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useCallback } from "react";
import type { MessageDoc } from "./types";
import {
  type MessagesQuery,
  type StreamingMessageUpdatesQuery,
  type ThreadQuery,
  useThreadMessages,
} from "./use-thread-messages";

// Mutation types for the agent API
type SendMessageMutation = FunctionReference<"mutation", "public", { threadId: string; prompt: string }, null>;

type StopThreadMutation = FunctionReference<"mutation", "public", { threadId: string }, null>;

type ResumeThreadMutation = FunctionReference<"mutation", "public", { threadId: string; prompt?: string }, null>;

function createOptimisticMessageDoc({ prompt, threadId }: { threadId: string; prompt: string }): MessageDoc {
  const now = Date.now();
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = `optimistic-${suffix}`;
  return {
    _id: id,
    _creationTime: now,
    threadId,
    id,
    role: "user",
    parts: [{ type: "text", text: prompt }],
  };
}

export type UseAgentChatOptions = {
  /** Query to get thread status */
  getThread: ThreadQuery;
  /** Mutation to send a message */
  sendMessage: SendMessageMutation;
  /** Mutation to stop the thread */
  stopThread: StopThreadMutation;
  /** Mutation to resume the thread */
  resumeThread: ResumeThreadMutation;
  /** The thread ID to chat with */
  threadId: string;
  /** Query to list messages */
  listMessages: MessagesQuery;
  /** Query streaming message updates */
  streamUpdates: StreamingMessageUpdatesQuery;
  /** Whether to stream message updates. Defaults to true if streamingMessageUpdates is provided, false otherwise. */
  stream?: boolean;
};

export type UseAgentChatReturn = ReturnType<typeof useThreadMessages> & {
  /** Send a message to the thread */
  sendMessage: (prompt: string) => Promise<null>;
  /** Stop the thread */
  stop: () => Promise<null>;
  /** Resume the thread with an optional prompt */
  resume: (prompt?: string) => Promise<null>;
};

/**
 * Combined hook for chat functionality with an agent thread.
 *
 * This hook combines `useThread` with streaming enabled and provides
 * mutation functions for sending messages, stopping, and resuming the thread.
 *
 * @example
 * ```tsx
 * const { messages, status, sendMessage, stop, resume, isRunning } = useAgentChat({
 *   listMessages: api.ai.chat.listChatMessagesWithStreams,
 *   getThread: api.ai.chat.getChatThread,
 *   sendMessage: api.ai.chat.sendChatMessage,
 *   stopThread: api.ai.chat.stopChatThread,
 *   resumeThread: api.ai.chat.resumeChatThread,
 *   threadId,
 * });
 *
 * // Send a message
 * await sendMessage("Hello!");
 *
 * // Stop the agent
 * if (isRunning) {
 *   await stop();
 * }
 *
 * // Resume after stopping or failure
 * if (isFailed || isStopped) {
 *   await resume();
 * }
 * ```
 */
export function useAgentChat(options: UseAgentChatOptions): UseAgentChatReturn {
  const {
    listMessages,
    streamUpdates,
    getThread,
    sendMessage: sendMessageRef,
    stopThread: stopThreadRef,
    resumeThread: resumeThreadRef,
    threadId,
    stream = false,
  } = options;

  // Use the combined thread hook with streaming
  const threadResult = useThreadMessages({
    messagesQuery: listMessages,
    streamingMessageUpdatesQuery: streamUpdates,
    threadQuery: getThread,
    threadId,
    skip: !!stream,
  });

  // Create mutation functions
  const sendMessageMutation = useMutation(sendMessageRef).withOptimisticUpdate((localStore, args) => {
    const currentMessages = localStore.getQuery(listMessages, { threadId: args.threadId }) ?? [];
    localStore.setQuery(listMessages, { threadId: args.threadId }, [
      ...currentMessages,
      createOptimisticMessageDoc(args),
    ]);
  });
  const stopThreadMutation = useMutation(stopThreadRef);
  const resumeThreadMutation = useMutation(resumeThreadRef);

  // Wrap mutations to provide simplified API with threadId pre-bound
  const sendMessage = useCallback(
    async (prompt: string): Promise<null> => {
      return sendMessageMutation({ threadId, prompt });
    },
    [sendMessageMutation, threadId],
  );

  const stop = useCallback(async (): Promise<null> => {
    return stopThreadMutation({ threadId });
  }, [stopThreadMutation, threadId]);

  const resume = useCallback(
    async (prompt?: string): Promise<null> => {
      return resumeThreadMutation({ threadId, prompt });
    },
    [resumeThreadMutation, threadId],
  );

  return {
    ...threadResult,
    sendMessage,
    stop,
    resume,
  };
}
