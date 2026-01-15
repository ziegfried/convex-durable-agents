"use client";

/**
 * React hooks for the durable_agent component.
 */

import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useMemo, useRef, useState } from "react";

// ============================================================================
// Types
// ============================================================================

export type ThreadStatus = "streaming" | "awaiting_tool_results" | "completed" | "failed" | "stopped";

export type ThreadDoc = {
  _id: string;
  _creationTime: number;
  status: ThreadStatus;
  stopSignal: boolean;
};

export type MessageDoc = {
  _id: string;
  _creationTime: number;
  threadId: string;
  order: number;
  message: {
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<unknown>;
  };
};

// UI-friendly message format
export type UIMessage = {
  id: string;
  key: string;
  order: number;
  role: "system" | "user" | "assistant" | "tool";
  status: ThreadStatus | "success";
  text: string;
  parts: Array<unknown>;
  _creationTime: number;
};

// Stream args for delta streaming
export type StreamArgs =
  | { kind: "list"; startOrder?: number }
  | { kind: "deltas"; cursors: Array<{ streamId: string; cursor: number }> };

// Stream message from the server
export type StreamMessage = {
  streamId: string;
  status: "streaming" | "finished" | "aborted";
  format?: "UIMessageChunk" | "TextStreamPart";
  order: number;
  threadId: string;
};

// Stream delta from the server
export type StreamDelta = {
  streamId: string;
  start: number;
  end: number;
  parts: Array<unknown>;
};

// Return type for syncStreams
export type SyncStreamsReturnValue =
  | { kind: "list"; messages: Array<StreamMessage> }
  | { kind: "deltas"; deltas: Array<StreamDelta> }
  | undefined;

// ============================================================================
// useSmoothText Hook
// ============================================================================

const FPS = 20;
const MS_PER_FRAME = 1000 / FPS;
const INITIAL_CHARS_PER_SEC = 128;

export type SmoothTextOptions = {
  charsPerSec?: number;
  startStreaming?: boolean;
  nowFn?: () => number;
};

/**
 * A hook that smoothly displays text as it is streamed.
 */
export function useSmoothText(
  text: string,
  { charsPerSec = INITIAL_CHARS_PER_SEC, startStreaming = false, nowFn = Date.now }: SmoothTextOptions = {},
): [string, { cursor: number; isStreaming: boolean }] {
  const [visibleText, setVisibleText] = useState(startStreaming ? "" : text || "");
  const smoothState = useRef({
    tick: nowFn(),
    cursor: visibleText.length,
    lastUpdate: nowFn(),
    lastUpdateLength: text.length,
    charsPerMs: charsPerSec / 1000,
    initial: true,
  });

  // eslint-disable-next-line react-hooks/refs
  const isStreaming = smoothState.current.cursor < text.length;

  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    if (smoothState.current.lastUpdateLength !== text.length) {
      const timeSinceLastUpdate = Date.now() - smoothState.current.lastUpdate;
      const latestCharsPerMs = (text.length - smoothState.current.lastUpdateLength) / timeSinceLastUpdate;
      const rateError = latestCharsPerMs - smoothState.current.charsPerMs;
      const charLag = smoothState.current.lastUpdateLength - smoothState.current.cursor;
      const lagRate = charLag / timeSinceLastUpdate;
      const newCharsPerMs =
        latestCharsPerMs + (smoothState.current.initial ? 0 : Math.max(0, (rateError + lagRate) / 2));
      smoothState.current.initial = false;
      smoothState.current.charsPerMs = Math.min(
        (2 * newCharsPerMs + smoothState.current.charsPerMs) / 3,
        smoothState.current.charsPerMs * 2,
      );
    }
    smoothState.current.tick = Math.max(smoothState.current.tick, Date.now() - MS_PER_FRAME);
    smoothState.current.lastUpdate = Date.now();
    smoothState.current.lastUpdateLength = text.length;

    function update() {
      if (smoothState.current.cursor >= text.length) {
        return;
      }
      const now = Date.now();
      const timeSinceLastUpdate = now - smoothState.current.tick;
      const charsSinceLastUpdate = Math.floor(timeSinceLastUpdate * smoothState.current.charsPerMs);
      const chars = Math.min(charsSinceLastUpdate, text.length - smoothState.current.cursor);
      smoothState.current.cursor += chars;
      smoothState.current.tick += chars / smoothState.current.charsPerMs;
      setVisibleText(text.slice(0, smoothState.current.cursor));
    }
    update();
    const interval = setInterval(update, MS_PER_FRAME);
    return () => clearInterval(interval);
  }, [text, isStreaming, charsPerSec]);

  // eslint-disable-next-line react-hooks/refs
  return [visibleText, { cursor: smoothState.current.cursor, isStreaming }];
}

// ============================================================================
// useThreadStatus Hook
// ============================================================================

type ThreadQuery = FunctionReference<"query", "public", { threadId: string }, ThreadDoc | null>;

/**
 * Hook to subscribe to thread status changes
 */
export function useThreadStatus(
  query: ThreadQuery,
  args: { threadId: string } | "skip",
): {
  thread: ThreadDoc | null | undefined;
  status: ThreadStatus | undefined;
  isLoading: boolean;
  isRunning: boolean;
  isComplete: boolean;
  isFailed: boolean;
  isStopped: boolean;
} {
  const thread = useQuery(query, args === "skip" ? "skip" : args);

  const status = thread?.status;
  const isLoading = thread === undefined;
  const isRunning = status === "streaming" || status === "awaiting_tool_results";
  const isComplete = status === "completed";
  const isFailed = status === "failed";
  const isStopped = status === "stopped";

  return {
    thread,
    status,
    isLoading,
    isRunning,
    isComplete,
    isFailed,
    isStopped,
  };
}

// ============================================================================
// useMessages Hook
// ============================================================================

type MessagesQuery = FunctionReference<"query", "public", { threadId: string }, MessageDoc[]>;

/**
 * Extract text from message content
 */
function extractText(content: string | Array<unknown>): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => {
        return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
      })
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/**
 * Extract text from parts array
 */
function extractTextFromParts(parts: Array<unknown>): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => {
      return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
    })
    .map((part) => part.text)
    .join("");
}

/**
 * Combine consecutive assistant/tool messages into a single message.
 * This merges tool-call parts with their corresponding tool-result parts by matching toolCallId.
 * Tool messages (role="tool") are merged into the preceding assistant message.
 */
function combineUIMessages(messages: UIMessage[]): UIMessage[] {
  return messages.reduce((acc, message) => {
    if (!acc.length) return [message];

    const previous = acc[acc.length - 1];

    // If current message is a tool message and previous is assistant, merge them
    if (message.role === "tool" && previous.role === "assistant") {
      // Merge parts, matching tool-results to tool-calls by toolCallId
      const newParts = [...previous.parts];
      for (const part of message.parts) {
        const toolCallId = (part as { toolCallId?: string }).toolCallId;
        if (toolCallId && (part as { type?: string }).type === "tool-result") {
          // Find and update existing tool-call part
          const existingIdx = newParts.findIndex(
            (p) =>
              (p as { toolCallId?: string }).toolCallId === toolCallId && (p as { type?: string }).type === "tool-call",
          );
          if (existingIdx !== -1) {
            // Merge result into tool-call, creating a combined tool part
            const existingPart = newParts[existingIdx] as {
              type: string;
              toolCallId: string;
              toolName: string;
              input?: unknown;
              args?: unknown;
            };
            newParts[existingIdx] = {
              ...existingPart,
              type: "tool-invocation",
              // Keep args from the original tool-call (might be stored as 'input' or 'args')
              args: existingPart.input ?? existingPart.args,
              result: (part as { result?: unknown }).result,
              state: "result",
            };
            continue;
          }
        }
        // If no matching tool-call found, add the part anyway
        newParts.push(part);
      }

      acc[acc.length - 1] = {
        ...previous,
        role: "assistant",
        status: message.status === "success" ? previous.status : message.status,
        parts: newParts,
        text: extractTextFromParts(newParts),
      };
      return acc;
    }

    // Otherwise, add as a new message
    acc.push(message);
    return acc;
  }, [] as UIMessage[]);
}

/**
 * Convert MessageDoc to UIMessage
 */
function toUIMessage(message: MessageDoc, threadStatus: ThreadStatus | undefined): UIMessage {
  const content = message.message.content;
  const text = extractText(content);

  // Build parts array
  const parts: Array<unknown> = [];
  if (typeof content === "string") {
    parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      parts.push(part);
    }
  }

  // Determine message status
  let status: ThreadStatus | "success" = "success";
  if (message.message.role === "assistant" && threadStatus) {
    // If this is the last assistant message and thread is still running, show streaming status
    status = threadStatus === "streaming" || threadStatus === "awaiting_tool_results" ? threadStatus : "success";
  }

  return {
    id: message._id,
    key: `${message.threadId}-${message.order}`,
    order: message.order,
    role: message.message.role,
    status,
    text,
    parts,
    _creationTime: message._creationTime,
  };
}

/**
 * Hook to fetch messages for a thread
 */
export function useMessages(
  query: MessagesQuery,
  threadQuery: ThreadQuery,
  args: { threadId: string } | "skip",
): {
  messages: UIMessage[];
  isLoading: boolean;
  thread: ThreadDoc | null | undefined;
} {
  const rawMessages = useQuery(query, args === "skip" ? "skip" : args);
  const thread = useQuery(threadQuery, args === "skip" ? "skip" : args);

  const messages = useMemo(() => {
    if (!rawMessages) return [];

    const threadStatus = thread?.status;

    // Convert to UI messages
    const uiMessages = rawMessages.map((msg) => toUIMessage(msg, threadStatus));

    // Sort by order
    uiMessages.sort((a, b) => a.order - b.order);

    // Combine assistant/tool messages with the same order (merges tool-call with tool-result)
    const combinedMessages = combineUIMessages(uiMessages);

    // Update the last assistant message status if thread is running
    if (threadStatus === "streaming" || threadStatus === "awaiting_tool_results") {
      for (let i = combinedMessages.length - 1; i >= 0; i--) {
        if (combinedMessages[i].role === "assistant") {
          combinedMessages[i].status = threadStatus;
          break;
        }
      }
    }

    return combinedMessages;
  }, [rawMessages, thread?.status]);

  return {
    messages,
    isLoading: rawMessages === undefined,
    thread,
  };
}

// ============================================================================
// Delta Streaming Hooks (Optional)
// ============================================================================

// Query type for streaming-enabled messages query
type StreamingMessagesQuery = FunctionReference<
  "query",
  "public",
  {
    threadId: string;
    streamArgs?: StreamArgs;
  },
  { messages: MessageDoc[]; streams?: SyncStreamsReturnValue }
>;

/**
 * Sort items by order
 */
function sorted<T extends { order: number }>(items: Array<T>): Array<T> {
  return [...items].sort((a, b) => a.order - b.order);
}

/**
 * Convert stream status to message status
 */
function statusFromStreamStatus(status: StreamMessage["status"]): ThreadStatus | "success" {
  switch (status) {
    case "streaming":
      return "streaming";
    case "finished":
      return "success";
    case "aborted":
      return "failed";
    default:
      return "success";
  }
}

/**
 * Create a blank UIMessage from a stream message
 */
function blankUIMessage(streamMessage: StreamMessage): UIMessage {
  return {
    id: `stream:${streamMessage.streamId}`,
    key: `${streamMessage.threadId}-${streamMessage.order}`,
    order: streamMessage.order,
    status: statusFromStreamStatus(streamMessage.status),
    text: "",
    _creationTime: Date.now(),
    role: "assistant",
    parts: [],
  };
}

/**
 * Get parts from deltas starting at a cursor position
 */
function getParts<T>(deltas: Array<StreamDelta>, startCursor: number): { parts: Array<T>; cursor: number } {
  const parts: Array<T> = [];
  let cursor = startCursor;
  for (const delta of deltas) {
    if (delta.start >= cursor) {
      parts.push(...(delta.parts as Array<T>));
      cursor = delta.end;
    }
  }
  return { parts, cursor };
}

/**
 * Update a UIMessage from TextStreamPart deltas
 */
function updateFromTextStreamParts(uiMessage: UIMessage, parts: Array<unknown>): UIMessage {
  const textParts = parts.filter((p): p is { type: "text-delta"; textDelta: string } => {
    return typeof p === "object" && p !== null && (p as { type?: string }).type === "text-delta";
  });

  if (textParts.length > 0) {
    const text = textParts.map((p) => p.textDelta).join("");
    return {
      ...uiMessage,
      parts: [{ type: "text", text }],
      text,
    };
  }
  return uiMessage;
}

/**
 * Dedupe messages by order, preferring non-pending messages
 */
function dedupeMessages(messages: Array<UIMessage>, streamMessages: Array<UIMessage>): Array<UIMessage> {
  const combined = sorted([...messages, ...streamMessages]);
  return combined.reduce(
    (msgs, msg) => {
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      if (!last) {
        return [msg];
      }
      if (last.order !== msg.order) {
        msgs.push(msg);
        return msgs;
      }
      // Same order - check if we should replace
      if ((last.status === "streaming" || last.status === "awaiting_tool_results") && msg.status === "success") {
        return [...msgs.slice(0, -1), msg];
      }
      return msgs;
    },
    [] as Array<UIMessage>,
  );
}

/**
 * Hook to fetch delta streams for streaming messages
 */
/* eslint-disable react-hooks/refs */
export function useDeltaStreams(
  query: StreamingMessagesQuery,
  args: { threadId: string } | "skip",
  options?: { startOrder?: number; skipStreamIds?: Array<string> },
): { streamMessage: StreamMessage; deltas: Array<StreamDelta> }[] | undefined {
  // Using ref for mutable state that persists across renders without triggering re-renders.
  // This is intentional - we need to track state during render for streaming data synchronization.
  const state = useRef<{
    startOrder: number;
    threadId: string | undefined;
    deltaStreams: Array<{ streamMessage: StreamMessage; deltas: Array<StreamDelta> }> | undefined;
  }>({
    startOrder: options?.startOrder ?? 0,
    deltaStreams: undefined,
    threadId: args === "skip" ? undefined : args.threadId,
  });
  const [cursors, setCursors] = useState<Record<string, number>>({});

  if (args !== "skip" && state.current.threadId !== args.threadId) {
    state.current.threadId = args.threadId;
    state.current.deltaStreams = undefined;
    state.current.startOrder = options?.startOrder ?? 0;
    setCursors({});
  }

  if (state.current.deltaStreams?.length || (options?.startOrder && options.startOrder < state.current.startOrder)) {
    const cacheFriendlyStartOrder = options?.startOrder ? options.startOrder - (options.startOrder % 10) : 0;
    if (cacheFriendlyStartOrder !== state.current.startOrder) {
      state.current.startOrder = cacheFriendlyStartOrder;
    }
  }

  // Get all active streams
  const streamList = useQuery(
    query,
    args === "skip"
      ? args
      : {
          threadId: args.threadId,
          streamArgs: { kind: "list", startOrder: state.current.startOrder } as StreamArgs,
        },
  ) as { streams: Extract<SyncStreamsReturnValue, { kind: "list" }> } | undefined;

  const streamMessages =
    args === "skip"
      ? undefined
      : !streamList
        ? state.current.deltaStreams?.map(({ streamMessage }) => streamMessage)
        : sorted(
            (streamList.streams?.messages ?? []).filter(
              ({ streamId, order }) =>
                !options?.skipStreamIds?.includes(streamId) && (!options?.startOrder || order >= options.startOrder),
            ),
          );

  // Get deltas for all active streams
  const cursorQuery = useQuery(
    query,
    args === "skip" || !streamMessages?.length
      ? ("skip" as const)
      : {
          threadId: args.threadId,
          streamArgs: {
            kind: "deltas",
            cursors: streamMessages.map(({ streamId }) => ({
              streamId,
              cursor: cursors[streamId] ?? 0,
            })),
          } as StreamArgs,
        },
  ) as { streams: Extract<SyncStreamsReturnValue, { kind: "deltas" }> } | undefined;

  const newDeltas = cursorQuery?.streams?.deltas;
  if (newDeltas?.length && streamMessages) {
    const newDeltasByStreamId = new Map<string, Array<StreamDelta>>();
    for (const delta of newDeltas) {
      const oldCursor = cursors[delta.streamId];
      if (oldCursor && delta.start < oldCursor) continue;
      const existing = newDeltasByStreamId.get(delta.streamId);
      if (existing) {
        existing.push(delta);
      } else {
        newDeltasByStreamId.set(delta.streamId, [delta]);
      }
    }
    const newCursors: Record<string, number> = {};
    for (const { streamId } of streamMessages) {
      const deltas = newDeltasByStreamId.get(streamId);
      const cursor = deltas?.length ? deltas[deltas.length - 1].end : cursors[streamId];
      if (cursor !== undefined) {
        newCursors[streamId] = cursor;
      }
    }
    setCursors(newCursors);

    state.current.deltaStreams = streamMessages.map((streamMessage) => {
      const streamId = streamMessage.streamId;
      const old = state.current.deltaStreams?.find((ds) => ds.streamMessage.streamId === streamId);
      const deltasList = newDeltasByStreamId.get(streamId);
      if (!deltasList && streamMessage === old?.streamMessage) {
        return old;
      }
      return {
        streamMessage,
        deltas: [...(old?.deltas ?? []), ...(deltasList ?? [])],
      };
    });
  }

  return state.current.deltaStreams;
}
/* eslint-enable react-hooks/refs */

/**
 * Hook to fetch streaming UIMessages from delta streams
 */
export function useStreamingUIMessages(
  query: StreamingMessagesQuery,
  args: { threadId: string } | "skip",
  options?: { startOrder?: number; skipStreamIds?: Array<string> },
): UIMessage[] | undefined {
  const [messageState, setMessageState] = useState<Record<string, { uiMessage: UIMessage; cursor: number }>>({});

  const streams = useDeltaStreams(query, args, options);

  useEffect(() => {
    if (!streams) return;
    // Check if there are new deltas
    let noNewDeltas = true;
    for (const stream of streams) {
      const lastDelta = stream.deltas.length > 0 ? stream.deltas[stream.deltas.length - 1] : undefined;
      const cursor = messageState[stream.streamMessage.streamId]?.cursor;
      if (!cursor) {
        noNewDeltas = false;
        break;
      }
      if (lastDelta && lastDelta.start >= cursor) {
        noNewDeltas = false;
        break;
      }
    }
    if (noNewDeltas) {
      return;
    }

    const newMessageState: Record<string, { uiMessage: UIMessage; cursor: number }> = {};
    for (const { deltas, streamMessage } of streams) {
      const { parts, cursor } = getParts<unknown>(deltas, 0);
      const uiMessage = updateFromTextStreamParts(blankUIMessage(streamMessage), parts);
      newMessageState[streamMessage.streamId] = { uiMessage, cursor };
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessageState(newMessageState);
  }, [messageState, streams]);

  const result = useMemo(() => {
    if (!streams) return undefined;
    const messages = streams
      .map(({ streamMessage }) => {
        const uiMessage = messageState[streamMessage.streamId]?.uiMessage;
        if (!uiMessage) return undefined;
        // Update status from stream metadata (more up-to-date than accumulated state)
        return { ...uiMessage, status: statusFromStreamStatus(streamMessage.status) };
      })
      .filter((uiMessage): uiMessage is UIMessage => uiMessage !== undefined);
    return messages;
  }, [messageState, streams]);

  return result;
}

/**
 * Hook to fetch messages with optional streaming support
 */
export function useMessagesWithStreaming(
  query: StreamingMessagesQuery,
  threadQuery: ThreadQuery,
  args: { threadId: string } | "skip",
  options?: {
    stream?: boolean;
    skipStreamIds?: Array<string>;
  },
): {
  messages: UIMessage[];
  isLoading: boolean;
  thread: ThreadDoc | null | undefined;
} {
  const thread = useQuery(threadQuery, args === "skip" ? "skip" : args);

  // Fetch persisted messages
  const rawResult = useQuery(query, args === "skip" ? "skip" : { threadId: args.threadId, streamArgs: undefined }) as
    | { messages: MessageDoc[] }
    | undefined;

  const rawMessages = rawResult?.messages;

  const startOrder = rawMessages?.length ? Math.min(...rawMessages.map((m) => m.order)) : 0;

  // Fetch streaming messages if enabled
  const streamMessages = useStreamingUIMessages(
    query,
    !options?.stream || args === "skip" || rawMessages === undefined ? "skip" : args,
    { startOrder, skipStreamIds: options?.skipStreamIds },
  );

  const messages = useMemo(() => {
    if (!rawMessages) return [];

    const threadStatus = thread?.status;

    // Convert to UI messages
    const uiMessages = rawMessages.map((msg) => toUIMessage(msg, threadStatus));

    // Sort by order
    uiMessages.sort((a, b) => a.order - b.order);

    // Combine assistant/tool messages with the same order (merges tool-call with tool-result)
    const combinedMessages = combineUIMessages(uiMessages);

    // Filter out finished streaming messages only if there's a corresponding database message
    const dbMessageOrders = new Set(combinedMessages.map((m) => m.order));
    const filteredStreamMessages = (streamMessages ?? []).filter((m) => {
      // Keep streaming messages that are still actively streaming
      if (m.status === "streaming") return true;
      // Keep finished streaming messages only if no database message exists yet
      return !dbMessageOrders.has(m.order);
    });

    // Merge with streaming messages
    const merged = dedupeMessages(combinedMessages, filteredStreamMessages);

    // Update the last assistant message status if thread is running
    if (threadStatus === "streaming" || threadStatus === "awaiting_tool_results") {
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i].role === "assistant") {
          merged[i].status = threadStatus;
          break;
        }
      }
    }

    return merged;
  }, [rawMessages, thread?.status, streamMessages]);

  return {
    messages,
    isLoading: rawMessages === undefined,
    thread,
  };
}

// ============================================================================
// Combined Hook
// ============================================================================

type UseThreadOptions = {
  /** Enable streaming messages for real-time updates */
  stream?: boolean;
  /** Stream IDs to skip (e.g., streams that have already been processed) */
  skipStreamIds?: Array<string>;
};

/**
 * Combined hook for thread status and messages.
 *
 * Supports two modes:
 * 1. Basic mode (default): Uses simple message polling
 * 2. Streaming mode: Uses delta streaming for real-time updates
 *
 * For streaming mode, pass a streaming-enabled query as the first argument
 * and set `options.stream: true`.
 */
export function useThread(
  messagesQuery: MessagesQuery | StreamingMessagesQuery,
  threadQuery: ThreadQuery,
  args: { threadId: string } | "skip",
  options?: UseThreadOptions,
): {
  messages: UIMessage[];
  thread: ThreadDoc | null | undefined;
  status: ThreadStatus | undefined;
  isLoading: boolean;
  isRunning: boolean;
  isComplete: boolean;
  isFailed: boolean;
  isStopped: boolean;
} {
  // Use streaming hook if enabled, otherwise use basic messages hook
  const streamingResult = useMessagesWithStreaming(
    messagesQuery as StreamingMessagesQuery,
    threadQuery,
    options?.stream ? args : "skip",
    { stream: options?.stream, skipStreamIds: options?.skipStreamIds },
  );

  const basicResult = useMessages(
    messagesQuery as MessagesQuery,
    threadQuery,
    options?.stream ? "skip" : args,
  );

  const { messages, isLoading: messagesLoading, thread } = options?.stream ? streamingResult : basicResult;
  const { status, isRunning, isComplete, isFailed, isStopped } = useThreadStatus(threadQuery, args);

  return {
    messages,
    thread,
    status,
    isLoading: messagesLoading,
    isRunning,
    isComplete,
    isFailed,
    isStopped,
  };
}
