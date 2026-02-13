import { readUIMessageStream, type UIMessageChunk } from "ai";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import type { UIMessageWithConvexMetadata } from "./message-utils";
import type { MessageDoc, StreamingMessageUpdates, ThreadDoc, ThreadStatus } from "./types";

export type MessagesQuery = FunctionReference<"query", "public", { threadId: string }, MessageDoc[]>;
export type ThreadQuery = FunctionReference<"query", "public", { threadId: string }, ThreadDoc | null>;
export type StreamingMessageUpdatesQuery = FunctionReference<
  "query",
  "public",
  { threadId: string; fromSeq?: number },
  StreamingMessageUpdates
>;

export function useThreadMessages({
  messagesQuery,
  streamingMessageUpdatesQuery,
  threadQuery,
  threadId,
  skip = false,
}: {
  messagesQuery: MessagesQuery;
  streamingMessageUpdatesQuery: StreamingMessageUpdatesQuery;
  threadQuery: ThreadQuery;
  threadId: string;
  skip?: boolean;
}): {
  messages: UIMessageWithConvexMetadata[];
  thread: ThreadDoc | null | undefined;
  status: ThreadStatus | undefined;
  isLoading: boolean;
  isRunning: boolean;
  isComplete: boolean;
  isFailed: boolean;
  isStopped: boolean;
} {
  const {
    messages,
    isLoading: messagesLoading,
    thread,
  } = useMessages(messagesQuery, threadQuery, skip ? "skip" : { threadId });
  const streamingUpdates = useStreamingUpdates(
    streamingMessageUpdatesQuery,
    threadId,
    messagesLoading ? undefined : messages,
  );
  const [finalMessages, setFinalMessages] = useState<UIMessageWithConvexMetadata[]>(messages);

  useEffect(() => {
    let active = true;
    if (streamingUpdates != null && streamingUpdates.messages.length > 0) {
      applyStreamingUpdates(structuredClone(messages), structuredClone(streamingUpdates)).then(
        (result) => {
          if (active) setFinalMessages(result);
        },
        (e) => console.error(e),
      );
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (active) setFinalMessages(messages);
    }
    return () => {
      active = false;
    };
  }, [messages, streamingUpdates]);

  const status = thread?.status;
  const isRunning = status === "streaming" || status === "awaiting_tool_results";
  const isComplete = status === "completed";
  const isFailed = status === "failed";
  const isStopped = status === "stopped";

  return {
    messages: streamingMessageUpdatesQuery != null ? finalMessages : messages,
    thread,
    status,
    isLoading: messagesLoading,
    isRunning,
    isComplete,
    isFailed,
    isStopped,
  };
}

export async function applyStreamingUpdates(
  messages: UIMessageWithConvexMetadata[],
  streamingUpdates: StreamingMessageUpdates,
) {
  const finalMessages = messages;
  const messageMap = new Map<string, number>();
  let committedSeq = -1;

  for (let i = 0; i < finalMessages.length; i++) {
    const message = finalMessages[i];
    messageMap.set(message!.id, i);
    committedSeq = Math.max(committedSeq, message!.metadata?.committedSeq ?? -1);
  }

  for (const update of streamingUpdates.messages) {
    const idx = messageMap.get(update.msgId);
    let message: UIMessageWithConvexMetadata;
    if (idx == null) {
      message = { id: update.msgId, parts: [], role: "assistant" };
      finalMessages.push(message);
      messageMap.set(update.msgId, finalMessages.length - 1);
    } else {
      message = finalMessages[idx]!;
    }

    const parts = update.parts.filter((p) => (p as any).seq > committedSeq);

    const result = readUIMessageStream({
      message,
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part as UIMessageChunk);
          }
          controller.close();
        },
      }),
    });

    for await (const msg of result) {
      if (msg.id === message.id) {
        finalMessages[idx!] = msg;
      } else {
        finalMessages.push(msg);
        messageMap.set(msg.id, finalMessages.length - 1);
      }
    }
  }
  return finalMessages;
}

function useStreamingUpdates(
  streamingMessageUpdatesQuery: StreamingMessageUpdatesQuery | undefined,
  threadId: string,
  messages: UIMessageWithConvexMetadata[] | undefined,
) {
  const [fromSeq, setFromSeq] = useState<number | null>(null);
  const streamingUpdates = useQuery(
    streamingMessageUpdatesQuery as StreamingMessageUpdatesQuery,
    streamingMessageUpdatesQuery == null || fromSeq == null ? "skip" : { threadId, fromSeq },
  );
  useEffect(() => {
    if (messages != null) {
      const max = Math.max(...messages.map((m) => m.metadata?.committedSeq ?? -1));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFromSeq(Number.isFinite(max) ? max + 1 : 0);
    }
  }, [messages]);
  return streamingUpdates;
}

/**
 * Hook to fetch messages for a thread
 */
export function useMessages(
  query: MessagesQuery,
  threadQuery: ThreadQuery,
  args: { threadId: string } | "skip",
): {
  messages: UIMessageWithConvexMetadata[];
  isLoading: boolean;
  thread: ThreadDoc | null | undefined;
} {
  const rawMessages = useQuery(query, args === "skip" ? "skip" : args);
  const thread = useQuery(threadQuery, args === "skip" ? "skip" : args);
  const messages = useMemo(() => {
    const persisted = rawMessages?.map((m) => addConvexMetadata(m)) ?? [];
    return persisted; // withActiveAssistantStatus(persisted, thread?.status);
  }, [rawMessages]);

  return {
    messages,
    isLoading: rawMessages === undefined,
    thread,
  };
}

function addConvexMetadata(message: MessageDoc): UIMessageWithConvexMetadata {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: {
      ...(message.metadata ?? {}),
      key: `${message.threadId}-${message.id}`,
      status: "success",
      _creationTime: message._creationTime,
      committedSeq: message.committedSeq,
    },
  };
}
