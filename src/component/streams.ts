import type { UIMessageChunk } from "ai";
import { type Infer, v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const TIMEOUT_INTERVAL = 10 * MINUTE;
const DELETE_STREAM_DELAY = MINUTE * 5;

export const create = mutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.id("streams"),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error(`Thread ${args.threadId} not found`);
    await ctx.db.patch(args.threadId, {
      seq: thread.seq + 1,
    });
    return await ctx.db.insert("streams", {
      threadId: args.threadId,
      state: { kind: "pending", scheduledAt: Date.now() },
      seq: thread.seq + 1,
    });
  },
});

export const take = mutation({
  args: {
    threadId: v.id("threads"),
    streamId: v.id("streams"),
    lockId: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"streams">> => {
    const stream = await ctx.db.get(args.streamId);
    if (stream === null) throw new Error(`Stream ${args.streamId} not found`);

    if (stream.state.kind === "pending") {
      const timeoutFnId = await ctx.scheduler.runAfter(TIMEOUT_INTERVAL, internal.streams.timeoutStream, {
        streamId: args.streamId,
      });
      await ctx.db.patch(args.streamId, {
        state: { kind: "streaming", lockId: args.lockId, lastHeartbeat: Date.now(), timeoutFnId },
      });
    } else if (stream.state.kind === "streaming") {
      if (stream.state.lockId !== args.lockId) {
        throw new Error(`Stream ${args.streamId} is already locked by another thread`);
      }
      console.warn(
        `Stream ${args.streamId} is already streaming with lockId=${stream.state.lockId}, updating heartbeat`,
      );
      await ctx.db.patch(args.streamId, {
        state: {
          kind: "streaming",
          lockId: args.lockId,
          lastHeartbeat: Date.now(),
          timeoutFnId: stream.state.timeoutFnId,
        },
      });
      //
    } else {
      throw new Error(`Stream ${args.streamId} is not pending or streaming`);
    }
    const thread = await ctx.runQuery(api.threads.get, { threadId: stream.threadId });
    if (!thread) throw new Error(`Thread ${stream.threadId} not found`);
    return stream;
  },
});

export const cancelInactiveStreams = mutation({
  args: {
    threadId: v.id("threads"),
    activeStreamId: v.id("streams"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for await (const stream of ctx.db.query("streams").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) {
      if (stream._id !== args.activeStreamId && stream.state.kind === "streaming") {
        await cancelStream(ctx, stream, "superseeded");
      }
    }
  },
});

export const isAlive = query({
  args: {
    streamId: v.id("streams"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) return false;
    return stream.state.kind === "streaming" && stream.state.lastHeartbeat > Date.now() - 30_000;
  },
});

/**
 * Add delta parts to a stream
 */
export const addDelta = mutation({
  args: {
    streamId: v.id("streams"),
    lockId: v.string(),
    parts: v.array(v.any()),
    seq: v.number(),
    msgId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await heartbeatStream(ctx, { streamId: args.streamId, lockId: args.lockId });

    await ctx.db.insert("deltas", {
      streamId: args.streamId,
      seq: args.seq,
      parts: args.parts,
      msgId: args.msgId,
    });

    return true;
  },
});

/**
 * Abort a stream
 */
export const abort = mutation({
  args: {
    streamId: v.id("streams"),
    reason: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error(`Stream not found: ${args.streamId}`);
    }
    await cancelStream(ctx, stream, args.reason);
    return true;
  },
});

/**
 * Mark a stream as finished
 */
export const finish = mutation({
  args: {
    streamId: v.id("streams"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error(`Stream not found: ${args.streamId}`);
    }
    await finishStream(ctx, stream);
    return null;
  },
});

async function cleanupTimeoutFn(ctx: MutationCtx, stream: Doc<"streams">): Promise<void> {
  if (stream.state.kind === "streaming" && stream.state.timeoutFnId) {
    const timeoutFn = await ctx.db.system.get(stream.state.timeoutFnId);
    if (timeoutFn?.state.kind === "pending") {
      await ctx.scheduler.cancel(stream.state.timeoutFnId);
    }
  }
}

async function finishStream(ctx: MutationCtx, stream: Doc<"streams">): Promise<void> {
  if (stream.state.kind === "finished" || stream.state.kind === "aborted") {
    return;
  }
  await cleanupTimeoutFn(ctx, stream);
  const cleanupFnId = await ctx.scheduler.runAfter(DELETE_STREAM_DELAY, api.streams.deleteStreamAsync, {
    streamId: stream._id,
  });
  await ctx.db.patch(stream._id, { state: { kind: "finished", endedAt: Date.now(), cleanupFnId } });
}

async function cancelStream(ctx: MutationCtx, stream: Doc<"streams">, reason: string): Promise<void> {
  if (!stream) {
    return;
  }
  if (stream.state.kind === "finished" || stream.state.kind === "aborted") {
    return;
  }
  const cleanupFnId = await ctx.scheduler.runAfter(DELETE_STREAM_DELAY, api.streams.deleteStreamAsync, {
    streamId: stream._id,
  });
  await ctx.db.patch(stream._id, { state: { kind: "aborted", reason, cleanupFnId } });
  await cleanupTimeoutFn(ctx, stream);
}

async function heartbeatStream(
  ctx: MutationCtx,
  args: { streamId: Id<"streams">; lockId: string },
): Promise<Doc<"streams"> | null> {
  const stream = await ctx.db.get(args.streamId);
  if (!stream) {
    throw new Error(`Stream not found ${args.streamId}`);
  }
  if (stream.state.kind !== "streaming") {
    throw new Error(`Stream ${args.streamId} is not streaming`);
  }
  if (stream.state.lockId !== args.lockId) {
    await cancelStream(ctx, stream, "locked by another thread");
    throw new Error(`Stream ${args.streamId} is locked by another thread`);
  }
  const thread = await ctx.db.get(stream.threadId);
  if (thread?.activeStream !== args.streamId) {
    await cancelStream(ctx, stream, "thread active stream mismatch");
    throw new Error(
      `Thread ${stream.threadId} has active stream ${thread?.activeStream ?? "NULL"} but expected ${args.streamId} (`,
    );
  }
  if (Date.now() - stream.state.lastHeartbeat < TIMEOUT_INTERVAL / 4) {
    return stream;
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
    state: { kind: "streaming", lockId: args.lockId, lastHeartbeat: Date.now(), timeoutFnId },
  });
  return stream;
}

/**
 * Handle stream timeout (internal)
 */
export const timeoutStream = internalMutation({
  args: { streamId: v.id("streams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream || stream.state.kind !== "streaming") {
      console.warn("Stream not found or not streaming", args.streamId);
      return null;
    }
    await cancelStream(ctx, stream, "timeout");
    return null;
  },
});

/**
 * Delete a stream and its deltas asynchronously
 */
export const deleteStreamAsync = mutation({
  args: {
    streamId: v.id("streams"),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deltas = await ctx.db
      .query("deltas")
      .withIndex("by_stream", (q) => q.eq("streamId", args.streamId))
      .take(100);

    for (const delta of deltas) {
      await ctx.db.delete(delta._id);
    }

    if (deltas.length < 100) {
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

const vStreamingMessageUpdates = v.object({
  messages: v.array(
    v.object({
      msgId: v.string(),
      parts: v.array(v.any()),
    }),
  ),
});

export type StreamingMessageUpdates = Infer<typeof vStreamingMessageUpdates>;

export const queryStreamingMessageUpdates = query({
  args: {
    threadId: v.id("threads"),
    fromSeq: v.optional(v.number()),
  },
  returns: vStreamingMessageUpdates,
  handler: async (ctx, args): Promise<StreamingMessageUpdates> => {
    const streams = await ctx.db
      .query("streams")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .filter((q) => q.gte(q.field("seq"), args.fromSeq ?? 0))
      .order("asc")
      .collect();

    const result: Array<{ msgId: string; parts: unknown[] }> = [];
    const allIds = new Set<string>();
    const byStreamIds: Map<string, Map<string, string>> = new Map();

    for (const stream of streams) {
      const deltas = await ctx.db
        .query("deltas")
        .withIndex("by_stream", (q) => q.eq("streamId", stream._id))
        .order("asc")
        .collect();
      for (const delta of deltas) {
        if (!byStreamIds.has(delta.msgId)) byStreamIds.set(delta.msgId, new Map());
        const index = result.findIndex((m) => m.msgId === delta.msgId);
        const parts = replacePartIds(delta.parts, byStreamIds.get(delta.msgId)!, allIds);
        for (const part of parts) {
          (part as any).seq = stream.seq;
        }
        if (index === -1) {
          result.push({ msgId: delta.msgId, parts });
        } else {
          result[index]!.parts.push(...parts);
        }
      }
    }

    return {
      messages: result,
    };
  },
});

export function replacePartIds(
  parts: UIMessageChunk[],
  newIds: Map<string, string>,
  prevIds: Set<string>,
): UIMessageChunk[] {
  let idSeq = 0;
  const generateId = () => {
    while (true) {
      const id = `${idSeq++}`;
      if (!prevIds.has(id)) {
        prevIds.add(id);
        return id;
      }
    }
  };

  const newParts = parts.map((part) => {
    if ("id" in part) {
      const id = part.id;
      if (id) {
        if (newIds.has(id)) {
          return { ...part, id: newIds.get(id)! };
        }
        const newId = generateId();
        newIds.set(id, newId);
        return { ...part, id: newId };
      }
    }
    return part;
  });
  return newParts;
}
