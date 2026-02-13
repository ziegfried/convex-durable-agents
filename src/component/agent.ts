import type { FunctionHandle, FunctionReference, GenericDataModel, GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import { Logger } from "../logger.js";
import { STREAM_LIVENESS_THRESHOLD_MS } from "../streaming.js";
import { api, internal } from "./_generated/api.js";
import { action, mutation } from "./_generated/server.js";
import { cancelStream, isAlive } from "./streams.js";

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/**
 * Helper to enqueue an action either via workpool or direct scheduler.
 * @param action - A FunctionHandle string (for workpool) or FunctionReference (for scheduler)
 * @param workpoolHandle - If provided and action is a string, use workpool; otherwise use scheduler
 */
export async function enqueueAction(
  ctx: MutationCtx,
  workpoolHandle: string | undefined,
  action: FunctionHandle<"action"> | FunctionReference<"action", any, any, any>,
  args: Record<string, unknown>,
) {
  // Only use workpool if:
  // 1. workpoolHandle is provided, AND
  // 2. action is a string (function handle) - FunctionReferences can't be serialized for workpool
  if (workpoolHandle && typeof action === "string") {
    await ctx.runMutation(workpoolHandle as FunctionHandle<"mutation">, {
      action,
      args,
    });
  } else {
    await ctx.scheduler.runAfter(0, action as FunctionHandle<"action">, args);
  }
}

/**
 * Continue the agent stream - called to start or resume processing
 *
 * This action is called by the client via the DurableAgent class.
 * It receives the model, instructions, and tool definitions at runtime.
 */
export const continueStream = mutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const logger = new Logger(`agent:continueStream:${args.threadId}`);
    logger.debug("continueStream invoked");

    // Check thread status
    const thread = await ctx.runQuery(internal.threads.getWithStreamFnHandle, {
      threadId: args.threadId,
    });
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    logger.debug(
      `Thread loaded: status=${thread.status}, stopSignal=${!!thread.stopSignal}, activeStream=${thread.activeStream ?? "none"}`,
    );

    // Check stop signal
    if (thread.stopSignal) {
      const previousStatus = thread.status;
      const activeStreamId = thread.activeStream ?? null;
      logger.debug(
        `Stop signal detected, transitioning thread to stopped and clearing active stream=${activeStreamId ?? "none"}`,
      );
      await ctx.db.patch(thread._id, {
        status: "stopped",
        activeStream: null,
        continue: false,
      });
      if (thread.onStatusChangeHandle && previousStatus !== "stopped") {
        await ctx.runMutation(thread.onStatusChangeHandle as FunctionHandle<"mutation">, {
          threadId: args.threadId,
          status: "stopped",
          previousStatus,
        });
      }
      if (activeStreamId) {
        const activeStream = await ctx.db.get(activeStreamId);
        if (activeStream) {
          logger.debug(`Cancelling active stream=${activeStreamId} due to stop signal`);
          await cancelStream(ctx, activeStream, "stopSignal");
        }
      }
      return null;
    }

    // Check if thread is in stopped state
    if (thread.status === "stopped") {
      logger.debug("Thread already in stopped state, skipping");
      return null;
    }

    // Check for pending tool calls
    const pendingToolCalls = await ctx.runQuery(api.tool_calls.listPending, {
      threadId: args.threadId,
    });
    if (pendingToolCalls.length > 0) {
      logger.debug(`${pendingToolCalls.length} pending tool calls remain, deferring continuation`);
      return null;
    }
    logger.debug("No pending tool calls");

    if (thread.activeStream) {
      const curActiveStream = await ctx.db.get(thread.activeStream);
      logger.debug(
        `Existing active stream: id=${thread.activeStream}, state=${curActiveStream?.state.kind ?? "missing"}`,
      );
      if (isAlive(curActiveStream)) {
        logger.debug("Active stream still alive, setting continue flag");
        await ctx.db.patch(thread._id, { continue: true });
        return null;
      }
      if (curActiveStream?.state.kind === "streaming") {
        const heartbeatAgeMs = Date.now() - curActiveStream.state.lastHeartbeat;
        logger.warn(
          `Cancelling expired streaming stream=${curActiveStream._id} (heartbeatAgeMs=${heartbeatAgeMs}, livenessThresholdMs=${STREAM_LIVENESS_THRESHOLD_MS})`,
        );
        await cancelStream(ctx, curActiveStream, "expired");
      }
      if (curActiveStream?.state.kind === "pending") {
        logger.debug("Cancelling superseded pending stream");
        await cancelStream(ctx, curActiveStream, "superseeded");
      }
    } else {
      logger.debug("No existing active stream");
    }

    logger.debug("Creating new stream...");
    const nextStreamId = await ctx.runMutation(api.streams.create, {
      threadId: args.threadId,
    });
    await ctx.db.patch(thread._id, { activeStream: nextStreamId, status: "streaming", continue: false });
    logger.debug(`New active stream set: stream=${nextStreamId}`);

    await ctx.runMutation(api.streams.cancelInactiveStreams, {
      threadId: args.threadId,
      activeStreamId: nextStreamId,
    });
    logger.debug("Inactive streams cancelled");

    // Schedule the stream handler (via workpool if configured)
    const useWorkpool = !!thread.workpoolEnqueueAction;
    logger.debug(`Scheduling stream handler (workpool=${useWorkpool})`);
    await enqueueAction(
      ctx,
      thread.workpoolEnqueueAction ?? undefined,
      thread.streamFnHandle as FunctionHandle<"action">,
      { threadId: args.threadId, streamId: nextStreamId as string },
    );
    logger.debug("Stream handler enqueued");

    return null;
  },
});

export const tryContinueAllThreads = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Manual/admin recovery entrypoint: intentionally unscheduled by default.
    // Invoke this action after outages/deploy interruptions to re-drive incomplete threads.
    const threads = await ctx.runQuery(api.threads.listIncomplete);
    for (const threadId of threads) {
      await ctx.runMutation(api.agent.continueStream, {
        threadId,
      });
    }
    return null;
  },
});
