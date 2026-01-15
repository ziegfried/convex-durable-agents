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

// AI SDK message format
export const vMessage = v.object({
  role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant"), v.literal("tool")),
  content: vMessageContent,
});

// Streaming message state - tracks the lifecycle of a streaming session
export const vStreamingState = v.union(
  v.object({
    kind: v.literal("streaming"),
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
  }),
);

// Stream format type
export const vStreamFormat = v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart"));

const schema = defineSchema({
  // Minimal state for the agent tool loop
  threads: defineTable({
    status: vThreadStatus,
    stopSignal: v.boolean(),
    streamFnHandle: v.string(),
    streamId: v.optional(v.union(v.string(), v.null())),
    // Optional workpool handles for scheduling actions
    workpoolEnqueueAction: v.optional(v.string()),
    toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
  }),

  // AI SDK compatible message storage
  messages: defineTable({
    threadId: v.id("threads"),
    order: v.number(),
    message: vMessage,
  }).index("by_thread", ["threadId", "order"]),

  // Track pending tool executions
  tool_calls: defineTable({
    threadId: v.id("threads"),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_tool_call_id", ["toolCallId"]),

  // Active streaming sessions (optional delta streaming feature)
  streaming_messages: defineTable({
    threadId: v.id("threads"),
    order: v.number(),
    state: vStreamingState,
    format: v.optional(vStreamFormat),
  }).index("by_thread_state_order", ["threadId", "state.kind", "order"]),

  // Streaming deltas - stores chunks of streaming data
  stream_deltas: defineTable({
    streamId: v.id("streaming_messages"),
    start: v.number(),
    end: v.number(),
    parts: v.array(v.any()),
  }).index("by_stream_start_end", ["streamId", "start", "end"]),
});

export default schema;
