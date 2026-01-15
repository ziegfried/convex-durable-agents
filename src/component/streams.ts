import type { Infer } from "convex/values";
import { v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { vStreamFormat } from "./schema.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const MAX_DELTAS_PER_REQUEST = 1000;
const MAX_DELTAS_PER_STREAM = 100;
const TIMEOUT_INTERVAL = 10 * MINUTE;
const DELETE_STREAM_DELAY = MINUTE * 5;

// Stream message validator for public API
export const vStreamMessage = v.object({
  streamId: v.string(),
  status: v.union(v.literal("streaming"), v.literal("finished"), v.literal("aborted")),
  format: v.optional(vStreamFormat),
  order: v.number(),
  threadId: v.string(),
});

export type StreamMessage = Infer<typeof vStreamMessage>;

// Stream delta validator for public API
export const vStreamDelta = v.object({
  streamId: v.string(),
  start: v.number(),
  end: v.number(),
  parts: v.array(v.any()),
});

export type StreamDelta = Infer<typeof vStreamDelta>;

// Internal delta validator matching the schema
const deltaValidator = v.object({
  streamId: v.id("streaming_messages"),
  start: v.number(),
  end: v.number(),
  parts: v.array(v.any()),
});

// Convert doc to public stream message
function publicStreamMessage(m: Doc<"streaming_messages">): StreamMessage {
  return {
    streamId: m._id as string,
    status: m.state.kind,
    format: m.format,
    order: m.order,
    threadId: m.threadId as string,
  };
}

/**
 * Create a new streaming session
 */
export const create = mutation({
  args: {
    threadId: v.id("threads"),
    order: v.number(),
    format: v.optional(vStreamFormat),
  },
  returns: v.id("streaming_messages"),
  handler: async (ctx, args) => {
    const state = { kind: "streaming" as const, lastHeartbeat: Date.now() };
    const streamId = await ctx.db.insert("streaming_messages", {
      threadId: args.threadId,
      order: args.order,
      format: args.format,
      state,
    });

    const timeoutFnId = await ctx.scheduler.runAfter(TIMEOUT_INTERVAL, internal.streams.timeoutStream, { streamId });

    await ctx.db.patch(streamId, { state: { ...state, timeoutFnId } });
    return streamId;
  },
});

/**
 * Add delta parts to a stream
 */
export const addDelta = mutation({
  args: deltaValidator,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      console.warn("[streams.addDelta] Stream not found:", args.streamId);
      return false;
    }
    if (stream.state.kind !== "streaming") {
      console.warn("[streams.addDelta] Stream not active:", args.streamId, "state:", stream.state.kind);
      return false;
    }
    await ctx.db.insert("stream_deltas", args);
    await heartbeatStream(ctx, { streamId: args.streamId });
    return true;
  },
});

/**
 * List deltas for multiple streams with cursor support
 */
export const listDeltas = query({
  args: {
    threadId: v.id("threads"),
    cursors: v.array(v.object({ streamId: v.id("streaming_messages"), cursor: v.number() })),
  },
  returns: v.array(vStreamDelta),
  handler: async (ctx, args): Promise<Array<StreamDelta>> => {
    let totalDeltas = 0;
    const deltas: Array<StreamDelta> = [];

    for (const cursor of args.cursors) {
      const streamDeltas = await ctx.db
        .query("stream_deltas")
        .withIndex("by_stream_start_end", (q) => q.eq("streamId", cursor.streamId).gte("start", cursor.cursor))
        .take(Math.min(MAX_DELTAS_PER_STREAM, MAX_DELTAS_PER_REQUEST - totalDeltas));

      totalDeltas += streamDeltas.length;
      deltas.push(
        ...streamDeltas.map((d) => ({
          streamId: d.streamId as string,
          start: d.start,
          end: d.end,
          parts: d.parts,
        })),
      );

      if (totalDeltas >= MAX_DELTAS_PER_REQUEST) {
        break;
      }
    }
    return deltas;
  },
});

/**
 * List active streams for a thread
 */
export const list = query({
  args: {
    threadId: v.id("threads"),
    startOrder: v.optional(v.number()),
    statuses: v.optional(v.array(v.union(v.literal("streaming"), v.literal("finished"), v.literal("aborted")))),
  },
  returns: v.array(vStreamMessage),
  handler: async (ctx, args) => {
    const statuses = args.statuses ?? ["streaming"];
    const allMessages: Array<Doc<"streaming_messages">> = [];

    for (const status of statuses) {
      const messages = await ctx.db
        .query("streaming_messages")
        .withIndex("by_thread_state_order", (q) =>
          q
            .eq("threadId", args.threadId)
            .eq("state.kind", status)
            .gte("order", args.startOrder ?? 0),
        )
        .order("desc")
        .take(100);
      allMessages.push(...messages);
    }

    return allMessages.map(publicStreamMessage);
  },
});

async function cleanupTimeoutFn(ctx: MutationCtx, stream: Doc<"streaming_messages">) {
  if (stream.state.kind === "streaming" && stream.state.timeoutFnId) {
    const timeoutFn = await ctx.db.system.get(stream.state.timeoutFnId);
    if (timeoutFn?.state.kind === "pending") {
      await ctx.scheduler.cancel(stream.state.timeoutFnId);
    }
  }
}

/**
 * Abort a stream
 */
export const abort = mutation({
  args: {
    streamId: v.id("streaming_messages"),
    reason: v.string(),
    finalDelta: v.optional(deltaValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error(`Stream not found: ${args.streamId}`);
    }
    if (args.finalDelta) {
      await ctx.db.insert("stream_deltas", args.finalDelta);
    }
    if (stream.state.kind !== "streaming") {
      console.warn("[streams.abort] Stream not active:", args.streamId, "state:", stream.state.kind);
      return false;
    }
    await cleanupTimeoutFn(ctx, stream);
    await ctx.db.patch(args.streamId, {
      state: { kind: "aborted", reason: args.reason },
    });
    return true;
  },
});

/**
 * Abort all streams for a thread at a specific order
 */
export const abortByOrder = mutation({
  args: { threadId: v.id("threads"), order: v.number(), reason: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const streams = await ctx.db
      .query("streaming_messages")
      .withIndex("by_thread_state_order", (q) =>
        q.eq("threadId", args.threadId).eq("state.kind", "streaming").eq("order", args.order),
      )
      .take(100);

    for (const stream of streams) {
      await cleanupTimeoutFn(ctx, stream);
      await ctx.db.patch(stream._id, {
        state: { kind: "aborted", reason: args.reason },
      });
    }
    return streams.length > 0;
  },
});

/**
 * Mark a stream as finished
 */
export const finish = mutation({
  args: {
    streamId: v.id("streaming_messages"),
    finalDelta: v.optional(deltaValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.finalDelta) {
      await ctx.db.insert("stream_deltas", args.finalDelta);
    }
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error(`Stream not found: ${args.streamId}`);
    }
    if (stream.state.kind !== "streaming") {
      console.warn("[streams.finish] Stream not active:", args.streamId, "state:", stream.state.kind);
      return null;
    }
    await cleanupTimeoutFn(ctx, stream);
    const cleanupFnId = await ctx.scheduler.runAfter(DELETE_STREAM_DELAY, api.streams.deleteStreamAsync, {
      streamId: args.streamId,
    });
    await ctx.db.patch(args.streamId, {
      state: { kind: "finished", endedAt: Date.now(), cleanupFnId },
    });
    return null;
  },
});

async function heartbeatStream(ctx: MutationCtx, args: { streamId: Id<"streaming_messages"> }): Promise<void> {
  const stream = await ctx.db.get(args.streamId);
  if (!stream) {
    console.warn("Stream not found", args.streamId);
    return;
  }
  if (stream.state.kind !== "streaming") {
    return;
  }
  if (Date.now() - stream.state.lastHeartbeat < TIMEOUT_INTERVAL / 4) {
    return;
  }
  if (!stream.state.timeoutFnId) {
    throw new Error("Stream has no timeout function");
  }
  const timeoutFn = await ctx.db.system.get(stream.state.timeoutFnId);
  if (!timeoutFn || timeoutFn.state.kind !== "pending") {
    throw new Error("Timeout function not found or not pending");
  }
  await ctx.scheduler.cancel(stream.state.timeoutFnId);
  const timeoutFnId = await ctx.scheduler.runAfter(TIMEOUT_INTERVAL, internal.streams.timeoutStream, {
    streamId: args.streamId,
  });
  await ctx.db.patch(args.streamId, {
    state: { kind: "streaming", lastHeartbeat: Date.now(), timeoutFnId },
  });
}

/**
 * Handle stream timeout (internal)
 */
export const timeoutStream = internalMutation({
  args: { streamId: v.id("streaming_messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream || stream.state.kind !== "streaming") {
      console.warn("Stream not found or not streaming", args.streamId);
      return null;
    }
    await ctx.db.patch(args.streamId, {
      state: { kind: "aborted", reason: "timeout" },
    });
    return null;
  },
});

/**
 * Delete a stream and its deltas asynchronously
 */
export const deleteStreamAsync = mutation({
  args: {
    streamId: v.id("streaming_messages"),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deltas = await ctx.db
      .query("stream_deltas")
      .withIndex("by_stream_start_end", (q) => q.eq("streamId", args.streamId))
      .take(MAX_DELTAS_PER_REQUEST);

    for (const delta of deltas) {
      await ctx.db.delete(delta._id);
    }

    if (deltas.length < MAX_DELTAS_PER_REQUEST) {
      // All deltas deleted, now delete the stream
      const stream = await ctx.db.get(args.streamId);
      if (stream) {
        await cleanupTimeoutFn(ctx, stream);
        if (stream.state.kind === "finished" && stream.state.cleanupFnId) {
          const cleanupFn = await ctx.db.system.get(stream.state.cleanupFnId);
          if (cleanupFn?.state.kind === "pending") {
            await ctx.scheduler.cancel(stream.state.cleanupFnId);
          }
        }
        await ctx.db.delete(args.streamId);
      }
    } else {
      // More deltas to delete, schedule continuation
      await ctx.scheduler.runAfter(0, api.streams.deleteStreamAsync, {
        streamId: args.streamId,
      });
    }
    return null;
  },
});
