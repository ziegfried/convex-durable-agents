"use client";

/**
 * React hooks for the durable_agent component.
 */

import type { UIMessage as AIUIMessage, TextUIPart } from "ai";
import { useMutation, useQuery } from "convex/react";
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

// Metadata type for custom fields in UIMessage
export type ConvexUIMessageMetadata = {
  key: string;
  order: number;
  status: ThreadStatus | "success";
  _creationTime: number;
};

// UI-friendly message format using AI SDK's UIMessage with custom metadata
export type UIMessage = AIUIMessage<ConvexUIMessageMetadata>;

// Tool part type matching AI SDK's ToolUIPart format (type: "tool-{toolName}")
// Uses discriminated union to match AI SDK's type structure
export type ToolCallUIPart =
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "input-streaming";
      input: unknown | undefined;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "input-available";
      input: unknown;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "output-available";
      input: unknown;
      output: unknown;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "output-error";
      input: unknown;
      errorText: string;
    };

// Re-export AI SDK part types for consumers
export type { TextUIPart } from "ai";

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

function isToolPart(part: unknown): part is ToolCallUIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof (part as { type: unknown }).type === "string" &&
    (part as { type: string }).type.startsWith("tool-")
  );
}

/**
 * Combine consecutive assistant messages by merging tool results.
 * This merges tool-call parts (input-available) with their corresponding tool-result parts (output-available)
 * by matching toolCallId.
 */
function combineUIMessages(messages: UIMessage[]): UIMessage[] {
  return messages.reduce((acc, message) => {
    if (!acc.length) return [message];
    const previous = acc[acc.length - 1];
    if (!previous) return [message];

    // Check if current message has tool results that match tool calls in previous message
    const prevToolCallIds = new Set(
      previous?.parts
        .filter((p): p is ToolCallUIPart => isToolPart(p) && p.state === "input-available")
        .map((p) => p.toolCallId),
    );

    const currToolResults = message.parts.filter(
      (p): p is ToolCallUIPart => isToolPart(p) && p.state === "output-available" && prevToolCallIds.has(p.toolCallId),
    );

    // If there are matching tool results, merge the messages
    if (currToolResults.length > 0) {
      const newParts = [...(previous?.parts ?? [])] as Array<TextUIPart | ToolCallUIPart>;

      for (const part of message.parts) {
        if (isToolPart(part) && part.state === "output-available") {
          const toolPart = part as ToolCallUIPart & { state: "output-available" };
          const existingIdx = newParts.findIndex(
            (p) => isToolPart(p) && p.toolCallId === toolPart.toolCallId && p.state === "input-available",
          );
          if (existingIdx !== -1) {
            const existing = newParts[existingIdx] as ToolCallUIPart & { state: "input-available" };
            newParts[existingIdx] = {
              type: existing.type,
              toolCallId: existing.toolCallId,
              state: "output-available",
              input: existing.input,
              output: toolPart.output,
            };
            continue;
          }
        }
        newParts.push(part as TextUIPart | ToolCallUIPart);
      }

      const newStatus = message.metadata?.status === "success" ? previous.metadata?.status : message.metadata?.status;

      acc[acc.length - 1] = {
        ...previous,
        parts: newParts,
        metadata: {
          ...previous.metadata!,
          status: newStatus ?? "success",
        },
      };
      return acc;
    }

    acc.push(message);
    return acc;
  }, [] as UIMessage[]);
}

/**
 * Convert a content part to AI SDK UIMessagePart format
 */
function toUIMessagePart(part: unknown): TextUIPart | ToolCallUIPart {
  if (typeof part !== "object" || part === null) {
    return { type: "text", text: String(part) };
  }

  const p = part as Record<string, unknown>;

  if (p.type === "text") {
    return { type: "text", text: String(p.text ?? "") };
  }

  if (p.type === "tool-call") {
    const toolName = String(p.toolName ?? "");
    return {
      type: `tool-${toolName}`,
      toolCallId: String(p.toolCallId ?? ""),
      state: "input-available",
      input: p.input ?? p.args,
    };
  }

  if (p.type === "tool-result") {
    const toolName = String(p.toolName ?? "");
    return {
      type: `tool-${toolName}`,
      toolCallId: String(p.toolCallId ?? ""),
      state: "output-available",
      input: p.input ?? p.args ?? {},
      output: p.result,
    };
  }

  if (p.type === "tool-invocation") {
    const toolName = String(p.toolName ?? "");
    const state = p.state === "result" ? "output-available" : "input-available";
    if (state === "output-available") {
      return {
        type: `tool-${toolName}`,
        toolCallId: String(p.toolCallId ?? ""),
        state: "output-available",
        input: p.input ?? p.args ?? {},
        output: p.result,
      };
    }
    return {
      type: `tool-${toolName}`,
      toolCallId: String(p.toolCallId ?? ""),
      state: "input-available",
      input: p.input ?? p.args,
    };
  }

  // Fallback: treat as text
  return { type: "text", text: JSON.stringify(part) };
}

/**
 * Convert MessageDoc to UIMessage
 */
function toUIMessage(message: MessageDoc, threadStatus: ThreadStatus | undefined): UIMessage {
  const content = message.message.content;

  // Build parts array with proper AI SDK types
  const parts: Array<TextUIPart | ToolCallUIPart> = [];
  if (typeof content === "string") {
    parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      parts.push(toUIMessagePart(part));
    }
  }

  // Determine message status
  let status: ThreadStatus | "success" = "success";
  if (message.message.role === "assistant" && threadStatus) {
    status = threadStatus === "streaming" || threadStatus === "awaiting_tool_results" ? threadStatus : "success";
  }

  // AI SDK UIMessage doesn't have 'tool' role - tool messages should be merged into assistant
  const role = message.message.role === "tool" ? "assistant" : message.message.role;

  return {
    id: message._id,
    role,
    parts,
    metadata: {
      key: `${message.threadId}-${message.order}`,
      order: message.order,
      status,
      _creationTime: message._creationTime,
    },
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
    uiMessages.sort((a, b) => (a.metadata?.order ?? 0) - (b.metadata?.order ?? 0));

    // Combine assistant/tool messages with the same order (merges tool-call with tool-result)
    const combinedMessages = combineUIMessages(uiMessages);

    // Update the last assistant message status if thread is running
    if (threadStatus === "streaming" || threadStatus === "awaiting_tool_results") {
      for (let i = combinedMessages.length - 1; i >= 0; i--) {
        if (combinedMessages[i]!.role === "assistant") {
          combinedMessages[i] = {
            ...combinedMessages[i]!,
            metadata: {
              ...combinedMessages[i]!.metadata!,
              status: threadStatus,
            },
          };
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
 * Sort items by order (supports both top-level order and metadata.order)
 */
function sorted<T extends { order?: number; metadata?: { order: number } }>(items: Array<T>): Array<T> {
  return [...items].sort((a, b) => {
    const aOrder = a.order ?? a.metadata?.order ?? 0;
    const bOrder = b.order ?? b.metadata?.order ?? 0;
    return aOrder - bOrder;
  });
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
    role: "assistant",
    parts: [],
    metadata: {
      key: `${streamMessage.threadId}-${streamMessage.order}`,
      order: streamMessage.order,
      status: statusFromStreamStatus(streamMessage.status),
      _creationTime: Date.now(),
    },
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
    const textUIPart: TextUIPart = { type: "text", text, state: "streaming" };
    return {
      ...uiMessage,
      parts: [textUIPart],
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
      const lastOrder = last.metadata?.order;
      const msgOrder = msg.metadata?.order;
      if (lastOrder !== msgOrder) {
        msgs.push(msg);
        return msgs;
      }
      // Same order - check if we should replace
      const lastStatus = last.metadata?.status;
      const msgStatus = msg.metadata?.status;
      if ((lastStatus === "streaming" || lastStatus === "awaiting_tool_results") && msgStatus === "success") {
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
          streamArgs: {
            kind: "list",
            startOrder: state.current.startOrder,
          } as StreamArgs,
        },
  ) as { streams: Extract<SyncStreamsReturnValue, { kind: "list" }> } | undefined;

  const streamMessages =
    args === "skip"
      ? undefined
      : !streamList
        ? state.current.deltaStreams?.map(({ streamMessage }: { streamMessage: StreamMessage }) => streamMessage)
        : sorted(
            (streamList.streams?.messages ?? []).filter(
              ({ streamId, order }: { streamId: string; order: number }) =>
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
            cursors: streamMessages.map(({ streamId }: { streamId: string }) => ({
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
      const cursor = deltas?.length ? deltas[deltas.length - 1]!.end : cursors[streamId];
      if (cursor !== undefined) {
        newCursors[streamId] = cursor;
      }
    }
    setCursors(newCursors);

    state.current.deltaStreams = streamMessages.map((streamMessage: StreamMessage) => {
      const streamId = streamMessage.streamId;
      const old = state.current.deltaStreams?.find(
        (ds: { streamMessage: StreamMessage; deltas: Array<StreamDelta> }) => ds.streamMessage.streamId === streamId,
      );
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

  const result = useMemo((): UIMessage[] | undefined => {
    if (!streams) return undefined;
    const messages: UIMessage[] = [];
    for (const { streamMessage } of streams) {
      const uiMessage = messageState[streamMessage.streamId]?.uiMessage;
      if (!uiMessage) continue;
      // Update status from stream metadata (more up-to-date than accumulated state)
      messages.push({
        ...uiMessage,
        metadata: {
          ...uiMessage.metadata!,
          status: statusFromStreamStatus(streamMessage.status),
        },
      });
    }
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
    uiMessages.sort((a, b) => (a.metadata?.order ?? 0) - (b.metadata?.order ?? 0));

    // Combine assistant/tool messages with the same order (merges tool-call with tool-result)
    const combinedMessages = combineUIMessages(uiMessages);

    // Filter out finished streaming messages only if there's a corresponding database message
    const dbMessageOrders = new Set(combinedMessages.map((m) => m.metadata?.order));
    const filteredStreamMessages = (streamMessages ?? []).filter((m) => {
      // Keep streaming messages that are still actively streaming
      if (m.metadata?.status === "streaming") return true;
      // Keep finished streaming messages only if no database message exists yet
      return !dbMessageOrders.has(m.metadata?.order);
    });

    // Merge with streaming messages
    const merged = dedupeMessages(combinedMessages, filteredStreamMessages);

    // Update the last assistant message status if thread is running
    if (threadStatus === "streaming" || threadStatus === "awaiting_tool_results") {
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i]!.role === "assistant") {
          merged[i] = {
            ...merged[i]!,
            metadata: {
              ...merged[i]!.metadata!,
              status: threadStatus,
            },
          };
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

  const basicResult = useMessages(messagesQuery as MessagesQuery, threadQuery, options?.stream ? "skip" : args);

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

// ============================================================================
// Helper Functions for UIMessage
// ============================================================================

/**
 * Extract text content from a UIMessage's parts
 */
export function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Get the status of a message from its metadata
 */
export function getMessageStatus(message: UIMessage): ThreadStatus | "success" {
  return message.metadata?.status ?? "success";
}

/**
 * Get the key for React rendering from message metadata
 */
export function getMessageKey(message: UIMessage): string {
  return message.metadata?.key ?? message.id;
}

/**
 * Get the order of a message from its metadata
 */
export function getMessageOrder(message: UIMessage): number {
  return message.metadata?.order ?? 0;
}

/**
 * Get the creation time of a message from its metadata
 */
export function getMessageCreationTime(message: UIMessage): number {
  return message.metadata?._creationTime ?? 0;
}

// ============================================================================
// useAgentChat Hook
// ============================================================================

// Mutation types for the agent API
type SendMessageMutation = FunctionReference<"mutation", "public", { threadId: string; prompt: string }, null>;

type StopThreadMutation = FunctionReference<"mutation", "public", { threadId: string }, null>;

type ResumeThreadMutation = FunctionReference<"mutation", "public", { threadId: string; prompt?: string }, null>;

export type UseAgentChatOptions = {
  /** Query to list messages with streaming support */
  listMessages: StreamingMessagesQuery;
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
  /** Enable streaming (defaults to true) */
  stream?: boolean;
  /** Stream IDs to skip */
  skipStreamIds?: Array<string>;
};

export type UseAgentChatReturn = {
  /** Messages in the thread */
  messages: UIMessage[];
  /** Thread document */
  thread: ThreadDoc | null | undefined;
  /** Current thread status */
  status: ThreadStatus | undefined;
  /** Whether the thread is loading */
  isLoading: boolean;
  /** Whether the thread is currently running (streaming or awaiting tool results) */
  isRunning: boolean;
  /** Whether the thread has completed */
  isComplete: boolean;
  /** Whether the thread has failed */
  isFailed: boolean;
  /** Whether the thread has been stopped */
  isStopped: boolean;
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
 *   listMessages: api.chat.listMessagesWithStreams,
 *   getThread: api.chat.getThread,
 *   sendMessage: api.chat.sendMessage,
 *   stopThread: api.chat.stopThread,
 *   resumeThread: api.chat.resumeThread,
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
    getThread,
    sendMessage: sendMessageRef,
    stopThread: stopThreadRef,
    resumeThread: resumeThreadRef,
    threadId,
    stream = true,
    skipStreamIds,
  } = options;

  // Use the combined thread hook with streaming
  const threadResult = useThread(listMessages, getThread, { threadId }, { stream, skipStreamIds });

  // Create mutation functions
  const sendMessageMutation = useMutation(sendMessageRef);
  const stopThreadMutation = useMutation(stopThreadRef);
  const resumeThreadMutation = useMutation(resumeThreadRef);

  // Wrap mutations to provide simplified API with threadId pre-bound
  const sendMessage = async (prompt: string): Promise<null> => {
    return sendMessageMutation({ threadId, prompt });
  };

  const stop = async (): Promise<null> => {
    return stopThreadMutation({ threadId });
  };

  const resume = async (prompt?: string): Promise<null> => {
    return resumeThreadMutation({ threadId, prompt });
  };

  return {
    ...threadResult,
    sendMessage,
    stop,
    resume,
  };
}
