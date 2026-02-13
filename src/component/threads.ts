import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { Logger } from "../logger.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, mutation, query } from "./_generated/server.js";
import { vThreadStatus } from "./schema.js";

const logger = new Logger("threads");
const FINALIZER_MISMATCH_ALERT_WINDOW_MS = 5 * 60 * 1000;
const FINALIZER_MISMATCH_ALERT_THRESHOLD = 3;

type FinalizerMismatchWindowState = {
  windowStartedAt: number;
  count: number;
  lastAlertAt: number | null;
};

const finalizerMismatchWindows = new Map<string, FinalizerMismatchWindowState>();

export function resetFinalizerMismatchAlertState(): void {
  finalizerMismatchWindows.clear();
}

export function trackFinalizerMismatchRate(
  threadId: string,
  now: number,
): { windowStartedAt: number; count: number; shouldAlert: boolean } {
  const existing = finalizerMismatchWindows.get(threadId);
  let state: FinalizerMismatchWindowState;
  if (!existing || now - existing.windowStartedAt >= FINALIZER_MISMATCH_ALERT_WINDOW_MS) {
    state = {
      windowStartedAt: now,
      count: 1,
      lastAlertAt: null,
    };
  } else {
    state = {
      windowStartedAt: existing.windowStartedAt,
      count: existing.count + 1,
      lastAlertAt: existing.lastAlertAt,
    };
  }
  const shouldAlert =
    state.count >= FINALIZER_MISMATCH_ALERT_THRESHOLD &&
    (state.lastAlertAt == null || now - state.lastAlertAt >= FINALIZER_MISMATCH_ALERT_WINDOW_MS);
  if (shouldAlert) {
    state.lastAlertAt = now;
  }
  finalizerMismatchWindows.set(threadId, state);
  return {
    windowStartedAt: state.windowStartedAt,
    count: state.count,
    shouldAlert,
  };
}

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
    streamId: thread.activeStream as string,
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
  activeStream: v.optional(v.union(v.id("streams"), v.null())),
  continue: v.optional(v.boolean()),
  seq: v.number(),
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
      seq: 0,
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
      if (lastMessage?.role === "user") {
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
    streamId: v.optional(v.id("streams")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    const previousStatus = thread.status;

    console.log(
      `SET STATUS ${args.threadId} ${previousStatus} -> ${args.status} active=${args.streamId ?? "unchanged"}`,
    );
    const patch: { status: Doc<"threads">["status"]; activeStream?: Id<"streams"> | null } = {
      status: args.status,
    };
    if (args.streamId !== undefined) {
      patch.activeStream = args.streamId;
    }
    await ctx.db.patch(args.threadId, patch);
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
    streamId: v.optional(v.id("streams")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    console.log(`CLEAR STREAM ID ${args.threadId} continue=${thread?.continue}`);
    if (args.streamId != null && thread?.activeStream !== args.streamId) {
      console.warn(
        `Thread ${args.threadId} active stream mismatch: ${thread?.activeStream} !== ${args.streamId} while trying to clear stream ID`,
      );
      return thread?.continue ?? false;
    }
    await ctx.db.patch(args.threadId, { activeStream: null });
    return thread?.continue ?? false;
  },
});

export const finalizeStreamTurn = mutation({
  args: {
    threadId: v.id("threads"),
    streamId: v.id("streams"),
    status: v.optional(vThreadStatus),
    expectedSeq: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    if (thread.activeStream !== args.streamId) {
      const staleStream = await ctx.db.get(args.streamId);
      const activeStream = thread.activeStream ? await ctx.db.get(thread.activeStream) : null;
      const rate = trackFinalizerMismatchRate(args.threadId, Date.now());
      const telemetry = {
        threadId: args.threadId,
        threadSeq: thread.seq,
        staleStreamId: args.streamId,
        staleStreamSeq: staleStream?.seq ?? null,
        staleStreamState: staleStream?.state.kind ?? "missing",
        activeStreamId: thread.activeStream ?? null,
        activeStreamSeq: activeStream?.seq ?? null,
        mismatchCountInWindow: rate.count,
        mismatchWindowMs: FINALIZER_MISMATCH_ALERT_WINDOW_MS,
        mismatchWindowStartedAt: rate.windowStartedAt,
      };
      if (staleStream?.state.kind === "aborted" && staleStream.state.reason === "expired") {
        logger.warn(
          "finalizeStreamTurn observed stale finalizer after continueStream cancelled stream as expired",
          telemetry,
        );
      }
      logger.warn("finalizeStreamTurn active stream mismatch", telemetry);
      if (rate.shouldAlert) {
        logger.error("finalizeStreamTurn mismatch rate exceeded threshold", {
          ...telemetry,
          mismatchAlertThreshold: FINALIZER_MISMATCH_ALERT_THRESHOLD,
        });
      }
      return false;
    }

    const activeStream = await ctx.db.get(args.streamId);
    if (!activeStream) {
      logger.warn("finalizeStreamTurn active stream not found", {
        threadId: args.threadId,
        streamId: args.streamId,
      });
      return false;
    }

    if (args.expectedSeq != null && activeStream.seq !== args.expectedSeq) {
      logger.warn("finalizeStreamTurn sequence mismatch", {
        threadId: args.threadId,
        streamId: args.streamId,
        expectedSeq: args.expectedSeq,
        actualSeq: activeStream.seq,
        threadSeq: thread.seq,
      });
      return false;
    }

    const previousStatus = thread.status;
    const nextStatus = args.status ?? previousStatus;
    const shouldContinue = thread.continue ?? false;

    await ctx.db.patch(args.threadId, {
      status: nextStatus,
      activeStream: null,
      continue: false,
    });
    if (thread.onStatusChangeHandle && previousStatus !== nextStatus) {
      await ctx.runMutation(thread.onStatusChangeHandle as FunctionHandle<"mutation">, {
        threadId: args.threadId,
        status: nextStatus,
        previousStatus,
      });
    }
    return shouldContinue;
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

export const listIncomplete = query({
  args: {},
  returns: v.array(v.id("threads")),
  handler: async (ctx, _args) => {
    const awaiting = await ctx.db
      .query("threads")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_tool_results"))
      .collect();
    const streaming = await ctx.db
      .query("threads")
      .withIndex("by_status", (q) => q.eq("status", "streaming"))
      .collect();
    return [...awaiting.map((t) => t._id), ...streaming.map((t) => t._id)];
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
      if (toolCall.timeoutFnId) {
        const timeoutFn = await ctx.db.system.get(toolCall.timeoutFnId);
        if (timeoutFn?.state.kind === "pending") {
          await ctx.scheduler.cancel(toolCall.timeoutFnId);
        }
      }
      await ctx.db.delete(toolCall._id);
    }
    // Delete the thread
    await ctx.db.delete(args.threadId);
    return null;
  },
});
