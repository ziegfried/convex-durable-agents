import type { UIMessageChunk } from "ai";
import { type Infer, v } from "convex/values";
import { Logger } from "../logger.js";
import { STREAM_LIVENESS_THRESHOLD_MS } from "../streaming.js";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";

const logger = new Logger("streams");

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
    const streamId = await ctx.db.insert("streams", {
      threadId: args.threadId,
      state: { kind: "pending", scheduledAt: Date.now() },
      seq: thread.seq + 1,
    });
    logger.debug(`Created stream=${streamId} for thread=${args.threadId} (seq=${thread.seq + 1})`);
    return streamId;
  },
});

export const insertToolCallOutcomeDelta = internalMutation({
  args: {
    threadId: v.id("threads"),
    msgId: v.string(),
    toolOutcomePart: v.union(
      v.object({
        type: v.literal("tool-output-available"),
        toolCallId: v.string(),
        output: v.any(),
        providerExecuted: v.optional(v.boolean()),
        providerMetadata: v.optional(v.any()),
        dynamic: v.optional(v.boolean()),
      }),
      v.object({
        type: v.literal("tool-output-error"),
        toolCallId: v.string(),
        errorText: v.string(),
        providerExecuted: v.optional(v.boolean()),
        providerMetadata: v.optional(v.any()),
        dynamic: v.optional(v.boolean()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error(`Thread ${args.threadId} not found`);
    await ctx.db.patch(args.threadId, {
      seq: thread.seq + 1,
    });
    const streamId = await ctx.db.insert("streams", {
      threadId: args.threadId,
      state: { kind: "streaming", lockId: crypto.randomUUID(), lastHeartbeat: Date.now() },
      seq: thread.seq + 1,
    });
    logger.debug(
      `Inserted tool call outcome delta: stream=${streamId}, toolCallId=${args.toolOutcomePart.toolCallId}, type=${args.toolOutcomePart.type}`,
    );
    await ctx.db.insert("deltas", {
      streamId,
      seq: 0,
      msgId: args.msgId,
      parts: [args.toolOutcomePart],
    });
    await finishStream(ctx, (await ctx.db.get(streamId))!);
    logger.debug(`Tool call outcome delta stream finished: stream=${streamId}`);
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
    const thread = await ctx.db.get(stream.threadId);
    if (!thread) throw new Error(`Thread ${stream.threadId} not found`);
    if (thread.activeStream !== stream._id) {
      logger.debug(
        `take: active stream mismatch for stream=${args.streamId} (thread.activeStream=${thread.activeStream}), aborting`,
      );
      await cancelStream(ctx, stream, "thread active stream mismatch");
      throw new Error(
        `Thread ${stream.threadId} active stream mismatch: ${thread.activeStream} !== ${stream._id} (during streams.take)`,
      );
    }

    logger.debug(`take: stream=${args.streamId}, currentState=${stream.state.kind}, lockId=${args.lockId}`);
    if (stream.state.kind === "pending") {
      const timeoutFnId = await ctx.scheduler.runAfter(TIMEOUT_INTERVAL, internal.streams.timeoutStream, {
        streamId: args.streamId,
      });
      await ctx.db.patch(args.streamId, {
        state: { kind: "streaming", lockId: args.lockId, lastHeartbeat: Date.now(), timeoutFnId },
      });
      logger.debug(`take: transitioned stream=${args.streamId} from pending to streaming`);
    } else if (stream.state.kind === "streaming") {
      if (stream.state.lockId !== args.lockId) {
        throw new Error(`Stream ${args.streamId} is already locked by another thread`);
      }
      logger.warn(`take: stream=${args.streamId} already streaming with same lockId, updating heartbeat`);
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
    let cancelledCount = 0;
    for await (const stream of ctx.db.query("streams").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) {
      if (stream._id !== args.activeStreamId && stream.state.kind === "streaming") {
        logger.debug(
          `cancelInactiveStreams: cancelling stream=${stream._id} (state=${stream.state.kind}) for thread=${args.threadId}`,
        );
        await cancelStream(ctx, stream, "superseeded");
        cancelledCount++;
      }
    }
    if (cancelledCount > 0) {
      logger.debug(`cancelInactiveStreams: cancelled ${cancelledCount} streams for thread=${args.threadId}`);
    }
  },
});

export function isAlive(stream: Doc<"streams"> | null): boolean {
  return (
    stream != null &&
    stream.state.kind === "streaming" &&
    stream.state.lastHeartbeat > Date.now() - STREAM_LIVENESS_THRESHOLD_MS
  );
}

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
    logger.debug(`addDelta: stream=${args.streamId}, seq=${args.seq}, parts=${args.parts.length}, msgId=${args.msgId}`);

    return true;
  },
});

export const heartbeat = mutation({
  args: {
    streamId: v.id("streams"),
    lockId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await heartbeatStream(ctx, args);
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
    logger.debug(`abort: stream=${args.streamId}, reason=${args.reason}, currentState=${stream.state.kind}`);
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
    logger.debug(`finish: stream=${args.streamId}, currentState=${stream.state.kind}`);
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
    logger.debug(`finishStream: stream=${stream._id} already in terminal state=${stream.state.kind}, skipping`);
    return;
  }
  await cleanupTimeoutFn(ctx, stream);
  const cleanupFnId = await ctx.scheduler.runAfter(DELETE_STREAM_DELAY, api.streams.deleteStreamAsync, {
    streamId: stream._id,
  });
  await ctx.db.patch(stream._id, { state: { kind: "finished", endedAt: Date.now(), cleanupFnId } });
  logger.debug(`finishStream: stream=${stream._id} marked finished (cleanup scheduled)`);
}

export async function cancelStream(ctx: MutationCtx, stream: Doc<"streams">, reason: string): Promise<void> {
  if (!stream) {
    return;
  }
  if (stream.state.kind === "finished" || stream.state.kind === "aborted") {
    logger.debug(`cancelStream: stream=${stream._id} already in terminal state=${stream.state.kind}, skipping`);
    return;
  }
  logger.debug(`cancelStream: stream=${stream._id}, reason=${reason}, currentState=${stream.state.kind}`);
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
    logger.debug(
      `heartbeat: lock mismatch for stream=${args.streamId} (expected=${args.lockId}, actual=${stream.state.lockId}), cancelling`,
    );
    await cancelStream(ctx, stream, "locked by another thread");
    throw new Error(`Stream ${args.streamId} is locked by another thread`);
  }
  const thread = await ctx.db.get(stream.threadId);
  if (thread?.activeStream !== args.streamId) {
    logger.debug(
      `heartbeat: active stream mismatch for stream=${args.streamId} (thread.activeStream=${thread?.activeStream ?? "NULL"}), cancelling`,
    );
    await cancelStream(ctx, stream, "thread active stream mismatch");
    throw new Error(
      `Thread ${stream.threadId} has active stream ${thread?.activeStream ?? "NULL"} but expected ${args.streamId} (`,
    );
  }
  const now = Date.now();
  const heartbeatAge = now - stream.state.lastHeartbeat;
  if (heartbeatAge < TIMEOUT_INTERVAL / 4) {
    await ctx.db.patch(args.streamId, {
      state: {
        kind: "streaming",
        lockId: args.lockId,
        lastHeartbeat: now,
        timeoutFnId: stream.state.timeoutFnId,
      },
    });
    return stream;
  }
  logger.debug(`heartbeat: refreshing timeout for stream=${args.streamId} (heartbeat age=${heartbeatAge}ms)`);
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
    state: { kind: "streaming", lockId: args.lockId, lastHeartbeat: now, timeoutFnId },
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
      logger.debug(
        `timeoutStream: stream=${args.streamId} not found or not streaming (state=${stream?.state.kind ?? "missing"}), skipping`,
      );
      return null;
    }
    logger.debug(
      `timeoutStream: timing out stream=${args.streamId} (lastHeartbeat age=${Date.now() - stream.state.lastHeartbeat}ms)`,
    );
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
      logger.debug(`deleteStreamAsync: stream=${args.streamId} fully deleted (${deltas.length} deltas removed)`);
    } else {
      // More deltas to delete, schedule continuation
      logger.debug(
        `deleteStreamAsync: stream=${args.streamId} deleted ${deltas.length} deltas, scheduling continuation`,
      );
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
