import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";

// Public tool call shape
export type ToolCallDoc = {
  _id: Id<"tool_calls">;
  _creationTime: number;
  threadId: Id<"threads">;
  msgId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
};

function publicToolCall(toolCall: Doc<"tool_calls">): ToolCallDoc {
  return {
    _id: toolCall._id,
    _creationTime: toolCall._creationTime,
    threadId: toolCall.threadId,
    msgId: toolCall.msgId,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    args: toolCall.args,
    result: toolCall.result,
    error: toolCall.error,
  };
}

// Tool call doc validator for return types
export const vToolCallDoc = v.object({
  _id: v.id("tool_calls"),
  _creationTime: v.number(),
  threadId: v.id("threads"),
  toolCallId: v.string(),
  msgId: v.string(),
  toolName: v.string(),
  args: v.any(),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
});

export const create = mutation({
  args: {
    threadId: v.id("threads"),
    msgId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
  },
  returns: vToolCallDoc,
  handler: async (ctx, args) => {
    const toolCallId = await ctx.db.insert("tool_calls", {
      threadId: args.threadId,
      msgId: args.msgId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      args: args.args,
    });

    const toolCall = await ctx.db.get(toolCallId);
    return publicToolCall(toolCall!);
  },
});

export const setResult = mutation({
  args: {
    id: v.id("tool_calls"),
    result: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db.get(args.id);
    console.log("setResult", toolCall?.toolCallId);
    if (!toolCall) {
      throw new Error(`Tool call ${args.id} not found`);
    }
    await ctx.db.patch(args.id, { result: args.result });
    return null;
  },
});

export const setError = mutation({
  args: {
    id: v.id("tool_calls"),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db.get(args.id);
    console.log("setError", toolCall?.toolCallId);
    if (!toolCall) {
      throw new Error(`Tool call ${args.id} not found`);
    }
    await ctx.db.patch(args.id, { error: args.error });
    return null;
  },
});

export const listPending = query({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.array(vToolCallDoc),
  handler: async (ctx, args) => {
    const toolCalls = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    // Filter to only pending tool calls (no result and no error)
    const pending = toolCalls.filter((tc) => tc.result === undefined && tc.error === undefined);

    return pending.map(publicToolCall);
  },
});

export const getByToolCallId = query({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
  },
  returns: v.union(vToolCallDoc, v.null()),
  handler: async (ctx, args) => {
    const toolCalls = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    const toolCall = toolCalls.find((tc) => tc.toolCallId === args.toolCallId);
    return toolCall ? publicToolCall(toolCall) : null;
  },
});

export const list = query({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.array(vToolCallDoc),
  handler: async (ctx, args) => {
    const toolCalls = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    return toolCalls.map(publicToolCall);
  },
});
