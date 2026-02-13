import type { FunctionHandle, FunctionReference, GenericDataModel, GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import { internalAction, internalMutation, mutation } from "./_generated/server.js";

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/**
 * Helper to enqueue an action either via workpool or direct scheduler.
 * @param action - A FunctionHandle string (for workpool) or FunctionReference (for scheduler)
 * @param workpoolHandle - If provided and action is a string, use workpool; otherwise use scheduler
 */
async function enqueueAction(
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

function createToolOutputPart(args: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result?: unknown;
  error?: string;
}) {
  const type = `tool-${args.toolName}`;
  if (args.error) {
    return {
      type,
      toolCallId: args.toolCallId,
      state: "output-error" as const,
      input: args.input,
      errorText: args.error,
    };
  }
  return {
    type,
    toolCallId: args.toolCallId,
    state: "output-available" as const,
    input: args.input,
    output: args.result,
  };
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
    // Check thread status
    const thread = await ctx.runQuery(internal.threads.getWithStreamFnHandle, {
      threadId: args.threadId,
    });
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    // Check stop signal
    if (thread.stopSignal) {
      await ctx.runMutation(api.threads.setStatus, {
        threadId: args.threadId,
        status: "stopped",
      });
      return null;
    }

    // Check if thread is in stopped state
    if (thread.status === "stopped") {
      console.log(`Thread ${args.threadId} is ${thread.status}`);
      return null;
    }

    // Check for pending tool calls
    const pendingToolCalls = await ctx.runQuery(api.tool_calls.listPending, {
      threadId: args.threadId,
    });
    if (pendingToolCalls.length > 0) {
      console.log(`Thread ${args.threadId} has ${pendingToolCalls.length} pending tool calls`);
      return null;
    }

    if (thread.activeStream) {
      const isAlive = await ctx.runQuery(api.streams.isAlive, {
        streamId: thread.activeStream,
      });
      if (isAlive) {
        console.log(`Thread ${args.threadId} has an active stream that is still alive`);
        await ctx.db.patch(thread._id, { continue: true });
        return null;
      }
    }

    const nextStreamId = await ctx.runMutation(api.streams.create, {
      threadId: args.threadId,
    });
    await ctx.db.patch(thread._id, { activeStream: nextStreamId, status: "streaming", continue: false });
    await ctx.runMutation(api.streams.cancelInactiveStreams, {
      threadId: args.threadId,
      activeStreamId: nextStreamId,
    });

    // Schedule the stream handler (via workpool if configured)
    await enqueueAction(
      ctx,
      thread.workpoolEnqueueAction ?? undefined,
      thread.streamFnHandle as FunctionHandle<"action">,
      { threadId: args.threadId, streamId: nextStreamId as string },
    );

    return null;
  },
});

/**
 * Schedule a tool call for execution
 */
export const scheduleToolCall = mutation({
  args: {
    threadId: v.id("threads"),
    msgId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
    handler: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get thread to access workpool config
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    // Create the tool call record
    await ctx.db.insert("tool_calls", {
      threadId: args.threadId,
      msgId: args.msgId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      args: args.args,
    });

    // Use tool execution workpool if specified, otherwise fall back to general workpool
    const workpoolHandle = thread.toolExecutionWorkpoolEnqueueAction ?? thread.workpoolEnqueueAction;

    // Schedule the tool execution (via workpool if configured)
    await enqueueAction(ctx, workpoolHandle, internal.agent.executeToolCall, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      handler: args.handler,
    });

    return null;
  },
});

/**
 * Schedule an async tool call - creates the record and notifies the callback,
 * but does NOT wait for the result. The result must be provided later via addToolResult.
 */
export const scheduleAsyncToolCall = mutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    msgId: v.string(),
    toolName: v.string(),
    args: v.any(),
    callback: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get thread to access workpool config
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    // Create the tool call record (will remain pending until addToolResult is called)
    await ctx.db.insert("tool_calls", {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      msgId: args.msgId,
      toolName: args.toolName,
      args: args.args,
    });

    // Use tool execution workpool if specified, otherwise fall back to general workpool
    const workpoolHandle = thread.toolExecutionWorkpoolEnqueueAction ?? thread.workpoolEnqueueAction;

    // Schedule the callback to notify the user (via workpool if configured) - it does NOT return the result
    await enqueueAction(ctx, workpoolHandle, internal.agent.executeAsyncToolCallback, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      args: args.args,
      callback: args.callback,
    });

    return null;
  },
});

/**
 * Execute a tool call
 */
export const executeToolCall = internalAction({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    handler: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get the tool call record
    console.log("executeToolCall 1", args.toolCallId);
    const toolCall = await ctx.runQuery(api.tool_calls.getByToolCallId, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });

    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }

    let result: unknown;
    let error: string | undefined;

    try {
      // Execute the tool handler
      // The handler string is passed from the client and we need to resolve it
      // For now, we'll use ctx.runAction with a dynamic reference
      // This requires the handler to be a proper function reference string
      const toolArgs = typeof toolCall.args === "object" && toolCall.args !== null ? toolCall.args : {};

      result = await ctx.runAction(args.handler as FunctionHandle<"action">, toolArgs as Record<string, unknown>);

      console.log("executeToolCall 2", result);

      await ctx.runMutation(api.agent.addToolResult, {
        result,
        toolCallId: toolCall.toolCallId,
      })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.log("executeToolCall 3", error);
      await ctx.runMutation(api.agent.addToolError, {
        error,
        toolCallId: toolCall.toolCallId,
      });
    }

    return null;
  },
});

/**
 * Execute an async tool callback - notifies the callback but does NOT wait for a result.
 * The callback receives the tool call info and can start a workflow, send a notification, etc.
 */
export const executeAsyncToolCallback = internalAction({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.any(),
    callback: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      // Call the callback with the tool call info - it does NOT return the result
      await ctx.runAction(args.callback as FunctionHandle<"action">, {
        threadId: args.threadId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        args: args.args,
      });
    } catch (e) {
      // Log callback errors but don't fail - the tool call remains pending
      // The user can still call addToolResult later
      console.error(`Async tool callback error for ${args.toolCallId}:`, e);
    }

    return null;
  },
});

/**
 * Called after each tool completes to check if we should continue
 */
export const onToolComplete = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Check thread status
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    // Check stop signal
    if (thread.stopSignal) {
      await ctx.runMutation(api.threads.setStatus, {
        threadId: args.threadId,
        status: "stopped",
      });
      return null;
    }

    // Check for pending tool calls
    const toolCalls = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    const pending = toolCalls.filter((tc) => tc.result === undefined && tc.error === undefined);

    if (pending.length === 0) {
      // All tool calls complete - schedule continuation
      await ctx.scheduler.runAfter(0, api.agent.continueStream, {
        threadId: args.threadId,
      });
    }

    return null;
  },
});

/**
 * Add a tool result for an async tool call.
 * This is called by the user after they have the result for an async tool.
 */
export const addToolResult = mutation({
  args: {
    toolCallId: v.string(),
    result: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log("addToolResult 1", args.toolCallId);
    const toolCall = await ctx.db
      .query("tool_calls")
      .withIndex("by_tool_call_id", (q) => q.eq("toolCallId", args.toolCallId))
      .unique();

    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }

    const threadId = toolCall.threadId;
    // Check if already completed
    if (toolCall.result !== undefined || toolCall.error !== undefined) {
      throw new Error(`Tool call ${args.toolCallId} already has a result`);
    }

    // Update the tool call record with the result
    await ctx.db.patch(toolCall._id, { result: args.result });

    // Add tool result message
    await ctx.runMutation(api.messages.appendToolOutcomePart, {
      threadId: threadId,
      msgId: toolCall.msgId,
      toolCallId: args.toolCallId,
      part: createToolOutputPart({
        toolCallId: args.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.args ?? {},
        result: args.result,
      }),
      throwOnMissingToolCallPart: false,
    });

    // Check if all tool calls are complete and continue if so
    await ctx.runMutation(internal.agent.onToolComplete, {
      threadId: threadId,
    });

    return null;
  },
});

/**
 * Add a tool error for an async tool call.
 * This is called by the user when an async tool fails.
 */
export const addToolError = mutation({
  args: {
    toolCallId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Find the tool call record
    console.log("addToolError 1", args.toolCallId);
    const toolCall = await ctx.db
      .query("tool_calls")
      .withIndex("by_tool_call_id", (q) => q.eq("toolCallId", args.toolCallId))
      .unique();

    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }

    const threadId = toolCall.threadId;

    // Check if already completed
    if (toolCall.result !== undefined || toolCall.error !== undefined) {
      throw new Error(`Tool call ${args.toolCallId} already has a result`);
    }

    // Update the tool call record with the error
    await ctx.db.patch(toolCall._id, { error: args.error });

    // Add tool result message with error
    await ctx.runMutation(api.messages.appendToolOutcomePart, {
      threadId: threadId,
      msgId: toolCall.msgId,
      toolCallId: args.toolCallId,
      part: createToolOutputPart({
        toolCallId: args.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.args ?? {},
        error: args.error,
      }),
      throwOnMissingToolCallPart: false,
    });

    // Check if all tool calls are complete and continue if so
    await ctx.runMutation(internal.agent.onToolComplete, {
      threadId: threadId,
    });

    return null;
  },
});
