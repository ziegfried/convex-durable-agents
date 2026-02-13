import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Thread status - represents the current state of the agent tool loop
export const vThreadStatus = v.union(
  v.literal("streaming"),
  v.literal("awaiting_tool_results"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

// AI SDK message content - supports both string and array of parts
export const vMessageContent = v.union(
  v.string(),
  v.array(v.any()), // AI SDK content parts (text, tool-call, tool-result, etc.)
);

export const vMessageRole = v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool"));

// AI SDK message format
export const vMessage = v.object({
  role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool")),
  content: vMessageContent,
});

// Streaming message state - tracks the lifecycle of a streaming session
export const vStreamingState = v.union(
  v.object({
    kind: v.literal("pending"),
    scheduledAt: v.number(),
  }),
  v.object({
    kind: v.literal("streaming"),
    lockId: v.string(),
    lastHeartbeat: v.number(),
    timeoutFnId: v.optional(v.id("_scheduled_functions")),
  }),
  v.object({
    kind: v.literal("finished"),
    endedAt: v.number(),
    cleanupFnId: v.optional(v.id("_scheduled_functions")),
  }),
  v.object({
    kind: v.literal("aborted"),
    reason: v.string(),
    cleanupFnId: v.optional(v.id("_scheduled_functions")),
  }),
);

const schema = defineSchema({
  // Minimal state for the agent tool loop
  threads: defineTable({
    status: vThreadStatus,
    // If true, the thread will stop. We set this when the user clicks the stop button.
    stopSignal: v.boolean(),
    // Function reference to stream handler action (see streamHandlerAction)
    streamFnHandle: v.string(),
    // Currently active stream for this thread. We only allow one at a time.
    activeStream: v.optional(v.union(v.id("streams"), v.null())),
    // If we try to continue the stream while it's still running, we set this to true.
    // At the end of the streamHandler, if this flag is set, we schedule continueStream right away.
    continue: v.optional(v.boolean()),
    // Optional workpool handles for scheduling actions
    workpoolEnqueueAction: v.optional(v.string()),
    // Optional workpool handle for scheduling tool executions (see scheduleToolCall)
    // If not provided, we use the same workpool as the stream handler.
    toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
    // Optional callback for status changes
    onStatusChangeHandle: v.optional(v.string()),
    // Monotonically increasing sequence number for streams of this thread
    seq: v.number(),
  }),

  // AI SDK compatible message storage
  messages: defineTable({
    threadId: v.id("threads"),
    // We use the AI SDK's generated message ID
    id: v.string(),
    role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant")),
    parts: v.array(v.any()),
    metadata: v.optional(v.any()),
    // Allow the client to ignore streaming deltas from streams with a seq <= this value
    committedSeq: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_msg_id", ["threadId", "id"]),

  // Track pending tool executions
  tool_calls: defineTable({
    threadId: v.id("threads"),
    msgId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_tool_call_id", ["toolCallId"]),

  streams: defineTable({
    threadId: v.id("threads"),
    // State of the stream. This is maintained even if we don't capture streaming deltas.
    state: vStreamingState,
    // Monotonically increasing sequence number for streams of a thread
    seq: v.number(),
  }).index("by_thread", ["threadId", "seq"]),

  deltas: defineTable({
    streamId: v.id("streams"),
    seq: v.number(),
    msgId: v.string(),
    parts: v.array(v.any()),
  }).index("by_stream", ["streamId", "seq"]),
});

export default schema;
