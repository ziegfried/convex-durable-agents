import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, mutation, query } from "./_generated/server.js";
import { vThreadStatus } from "./schema.js";

// Public thread shape
export type ThreadDoc = {
  _id: Id<"threads">;
  _creationTime: number;
  status: Doc<"threads">["status"];
  stopSignal: boolean;
  streamId: string | null | undefined;
  streamFnHandle: string;
  workpoolEnqueueAction?: string;
  toolExecutionWorkpoolEnqueueAction?: string;
};

function publicThread(thread: Doc<"threads">): ThreadDoc {
  return {
    _id: thread._id,
    _creationTime: thread._creationTime,
    status: thread.status,
    stopSignal: thread.stopSignal,
    streamId: thread.streamId,
    streamFnHandle: thread.streamFnHandle,
    workpoolEnqueueAction: thread.workpoolEnqueueAction,
    toolExecutionWorkpoolEnqueueAction: thread.toolExecutionWorkpoolEnqueueAction,
  };
}

// Thread doc validator for return types
export const vThreadDoc = v.object({
  _id: v.id("threads"),
  _creationTime: v.number(),
  status: vThreadStatus,
  stopSignal: v.boolean(),
  streamId: v.optional(v.union(v.string(), v.null())),
  streamFnHandle: v.string(),
  workpoolEnqueueAction: v.optional(v.string()),
  toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
});

export const vThreadDocWithStreamFnHandle = v.object({
  _id: v.id("threads"),
  _creationTime: v.number(),
  status: vThreadStatus,
  stopSignal: v.boolean(),
  streamId: v.optional(v.union(v.string(), v.null())),
  streamFnHandle: v.optional(v.union(v.string(), v.null())),
  workpoolEnqueueAction: v.optional(v.string()),
  toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
  onStatusChangeHandle: v.optional(v.string()),
});

export const create = mutation({
  args: {
    streamFnHandle: v.string(),
    workpoolEnqueueAction: v.optional(v.string()),
    toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
    onStatusChangeHandle: v.optional(v.string()),
  },
  returns: vThreadDoc,
  handler: async (ctx, args) => {
    // Create thread in "completed" (idle) state - it will transition to "streaming"
    // when resume() is called followed by continueStream()
    const threadId = await ctx.db.insert("threads", {
      status: "completed",
      stopSignal: false,
      streamFnHandle: args.streamFnHandle,
      workpoolEnqueueAction: args.workpoolEnqueueAction,
      toolExecutionWorkpoolEnqueueAction: args.toolExecutionWorkpoolEnqueueAction,
      onStatusChangeHandle: args.onStatusChangeHandle,
    });
    const thread = await ctx.db.get(threadId);
    return publicThread(thread!);
  },
});

export const get = query({
  args: { threadId: v.id("threads") },
  returns: v.union(vThreadDoc, v.null()),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    return thread ? publicThread(thread) : null;
  },
});

export const getWithStreamFnHandle = internalQuery({
  args: { threadId: v.id("threads") },
  returns: v.union(vThreadDocWithStreamFnHandle, v.null()),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    return thread ?? null;
  },
});

export const resume = mutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    if (thread.status === "completed" || thread.status === "failed" || thread.status === "stopped") {
      const lastMessage = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
        .order("desc")
        .first();
      if (lastMessage?.message.role === "user") {
        const previousStatus = thread.status;
        await ctx.db.patch(args.threadId, {
          status: "streaming",
          stopSignal: false,
        });
        if (thread.onStatusChangeHandle) {
          await ctx.runMutation(thread.onStatusChangeHandle as FunctionHandle<"mutation">, {
            threadId: args.threadId,
            status: "streaming",
            previousStatus,
          });
        }
      } else {
        console.warn(`Cannot resume thread status=${thread.status} without new user message`);
        return null;
      }
    } else {
      // status is streaming or awaiting_tool_results
      if (thread.stopSignal) {
        await ctx.db.patch(args.threadId, { stopSignal: false });
      }
    }
    return null;
  },
});

export const setStatus = mutation({
  args: {
    threadId: v.id("threads"),
    status: vThreadStatus,
    streamId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    const previousStatus = thread.status;
    await ctx.db.patch(args.threadId, {
      status: args.status,
      streamId: args.streamId,
    });
    if (thread.onStatusChangeHandle && previousStatus !== args.status) {
      await ctx.runMutation(thread.onStatusChangeHandle as FunctionHandle<"mutation">, {
        threadId: args.threadId,
        status: args.status,
        previousStatus,
      });
    }
    return null;
  },
});

export const clearStreamId = mutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, { streamId: null });
    return null;
  },
});

export const setStopSignal = mutation({
  args: {
    threadId: v.id("threads"),
    stopSignal: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    await ctx.db.patch(args.threadId, { stopSignal: args.stopSignal });
    return null;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(vThreadDoc),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const threads = await ctx.db.query("threads").order("desc").take(limit);
    return threads.map(publicThread);
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    // Delete all messages for this thread
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    for (const message of messages) {
      await ctx.db.delete(message._id);
    }
    // Delete all tool calls for this thread
    const toolCalls = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    for (const toolCall of toolCalls) {
      await ctx.db.delete(toolCall._id);
    }
    // Delete the thread
    await ctx.db.delete(args.threadId);
    return null;
  },
});
