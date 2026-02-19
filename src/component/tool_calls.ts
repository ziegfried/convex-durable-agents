import type { ProviderMetadata, UIMessagePart } from "ai";
import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { Logger } from "../utils/logger.js";
import { extractToolErrorInfo, isRetryableDecision, isRetryableToolErrorDefault } from "../utils/retry.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalAction, internalMutation, type MutationCtx, mutation, query } from "./_generated/server.js";
import { enqueueAction } from "./agent.js";
import { isAlive } from "./streams.js";

const logger = new Logger("tool_calls");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TOOL_CALL_TIMEOUT_MS = 30 * MINUTE;
const ASYNC_CALLBACK_MAX_ATTEMPTS = 3;
const ASYNC_CALLBACK_RETRY_BASE_MS = 5 * SECOND;
const SYNC_TOOL_MAX_ATTEMPTS = 3;
const SYNC_TOOL_RETRY_INITIAL_BACKOFF_MS = 500;

type RetryBackoffPolicy =
  | {
      strategy?: "fixed";
      delayMs: number;
      jitter?: boolean;
    }
  | {
      strategy: "exponential";
      initialDelayMs: number;
      multiplier?: number;
      maxDelayMs?: number;
      jitter?: boolean;
    };

type SyncToolRetryPolicy = {
  enabled: true;
  maxAttempts?: number;
  backoff?: RetryBackoffPolicy;
  shouldRetryError?: string;
};

function normalizeSyncToolRetryPolicy(value: unknown): SyncToolRetryPolicy | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== true) {
    return undefined;
  }
  return {
    enabled: true,
    maxAttempts: typeof obj.maxAttempts === "number" ? obj.maxAttempts : undefined,
    backoff: (obj.backoff as RetryBackoffPolicy | undefined) ?? undefined,
    shouldRetryError: typeof obj.shouldRetryError === "string" ? obj.shouldRetryError : undefined,
  };
}

function clampDelayMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function computeRetryDelayMs(attempt: number, backoff?: RetryBackoffPolicy): number {
  const policy = backoff ?? {
    strategy: "exponential" as const,
    initialDelayMs: SYNC_TOOL_RETRY_INITIAL_BACKOFF_MS,
    multiplier: 2,
    maxDelayMs: 10_000,
    jitter: true,
  };
  if ("delayMs" in policy) {
    const delayMs = clampDelayMs(policy.delayMs);
    if (!policy.jitter) return delayMs;
    return Math.floor(Math.random() * (delayMs + 1));
  }
  const initialDelayMs = clampDelayMs(policy.initialDelayMs);
  const multiplier = Number.isFinite(policy.multiplier ?? 2) ? (policy.multiplier ?? 2) : 2;
  const unbounded = initialDelayMs * multiplier ** Math.max(0, attempt - 1);
  const maxDelayMs = policy.maxDelayMs == null ? unbounded : clampDelayMs(policy.maxDelayMs);
  const delayMs = Math.min(unbounded, maxDelayMs);
  if (!policy.jitter) return delayMs;
  return Math.floor(Math.random() * (delayMs + 1));
}

function normalizeToolCallTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid tool call timeout: ${timeoutMs}`);
  }
  return Math.floor(timeoutMs);
}

function formatTimeoutMs(timeoutMs: number): string {
  if (timeoutMs % MINUTE === 0) {
    const minutes = timeoutMs / MINUTE;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (timeoutMs % SECOND === 0) {
    const seconds = timeoutMs / SECOND;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${timeoutMs}ms`;
}

async function cleanupTimeoutFn(ctx: MutationCtx, toolCall: Doc<"tool_calls">): Promise<void> {
  if (!toolCall.timeoutFnId) {
    return;
  }
  const timeoutFn = await ctx.db.system.get(toolCall.timeoutFnId);
  if (timeoutFn?.state.kind === "pending") {
    await ctx.scheduler.cancel(toolCall.timeoutFnId);
  }
}

async function cleanupExecutionRetryFn(ctx: MutationCtx, toolCall: Doc<"tool_calls">): Promise<void> {
  if (!toolCall.executionRetryFnId) {
    return;
  }
  const retryFn = await ctx.db.system.get(toolCall.executionRetryFnId);
  if (retryFn?.state.kind === "pending") {
    await ctx.scheduler.cancel(toolCall.executionRetryFnId);
  }
}

async function failToolCallIfPending(ctx: MutationCtx, toolCall: Doc<"tool_calls">, error: string): Promise<boolean> {
  const latest = await ctx.db.get(toolCall._id);
  if (!latest || latest.status !== "pending") {
    return false;
  }
  await cleanupTimeoutFn(ctx, latest);
  await cleanupExecutionRetryFn(ctx, latest);
  await ctx.db.patch(latest._id, {
    error,
    status: "failed",
    callbackLastError: error,
    executionRetryFnId: undefined,
    nextRetryAt: undefined,
  });

  if (latest.saveDelta) {
    logger.debug(`failPendingToolCall: inserting tool outcome delta for callId=${latest.toolCallId}`);
    await ctx.runMutation(internal.streams.insertToolCallOutcomeDelta, {
      threadId: latest.threadId,
      msgId: latest.msgId,
      toolOutcomePart: {
        toolCallId: latest.toolCallId,
        type: "tool-output-error",
        errorText: error || "Unknown error",
      },
    });
  }

  await ctx.runMutation(internal.tool_calls.onToolComplete, {
    threadId: latest.threadId,
  });
  return true;
}

async function getToolCallByScope(
  ctx: MutationCtx,
  args: { toolCallId: string; threadId: Id<"threads"> },
): Promise<Doc<"tool_calls"> | null> {
  return await ctx.db
    .query("tool_calls")
    .withIndex("by_thread_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
    .unique();
}

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
  status: "pending" | "completed" | "failed";
  callbackAttempt?: number;
  callbackLastError?: string;
  handler?: string;
  executionAttempt?: number;
  executionMaxAttempts?: number;
  executionLastError?: string;
  executionRetryPolicy?: unknown;
  nextRetryAt?: number;
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
    status: toolCall.status,
    callbackAttempt: toolCall.callbackAttempt,
    callbackLastError: toolCall.callbackLastError,
    handler: toolCall.handler,
    executionAttempt: toolCall.executionAttempt,
    executionMaxAttempts: toolCall.executionMaxAttempts,
    executionLastError: toolCall.executionLastError,
    executionRetryPolicy: toolCall.executionRetryPolicy,
    nextRetryAt: toolCall.nextRetryAt,
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
  status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
  callbackAttempt: v.optional(v.number()),
  callbackLastError: v.optional(v.string()),
  handler: v.optional(v.string()),
  executionAttempt: v.optional(v.number()),
  executionMaxAttempts: v.optional(v.number()),
  executionLastError: v.optional(v.string()),
  executionRetryPolicy: v.optional(v.any()),
  nextRetryAt: v.optional(v.number()),
});

type CreateToolCallArgs = {
  threadId: Id<"threads">;
  msgId: string;
  toolCallId: string;
  toolName: string;
  callback?: string;
  handler?: string;
  retry?: SyncToolRetryPolicy;
  args: unknown;
  saveDelta: boolean;
};

async function createToolCallRecord(ctx: MutationCtx, args: CreateToolCallArgs): Promise<Doc<"tool_calls">> {
  const existingToolCall = await ctx.db
    .query("tool_calls")
    .withIndex("by_thread_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
    .first();
  if (existingToolCall) {
    throw new Error(`Tool call ${args.toolCallId} already exists`);
  }
  logger.debug(
    `create: tool=${args.toolName}, callId=${args.toolCallId}, thread=${args.threadId}, msgId=${args.msgId}`,
  );
  const expiresAt = Date.now() + TOOL_CALL_TIMEOUT_MS;
  const toolCallId = await ctx.db.insert("tool_calls", {
    threadId: args.threadId,
    msgId: args.msgId,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    callback: args.callback,
    handler: args.handler,
    callbackAttempt: args.callback ? 0 : undefined,
    executionAttempt: args.retry ? 0 : undefined,
    executionMaxAttempts: args.retry?.maxAttempts,
    executionRetryPolicy: args.retry,
    args: args.args,
    saveDelta: args.saveDelta,
    timeoutMs: TOOL_CALL_TIMEOUT_MS,
    expiresAt,
    status: "pending",
  });
  const timeoutFnId = await ctx.scheduler.runAfter(TOOL_CALL_TIMEOUT_MS, internal.tool_calls.failPendingToolCall, {
    threadId: args.threadId,
    toolCallId: args.toolCallId,
  });
  await ctx.db.patch(toolCallId, { timeoutFnId });

  const toolCall = await ctx.db.get(toolCallId);
  if (!toolCall) {
    throw new Error(`Tool call ${toolCallId} not found after creation`);
  }
  return toolCall;
}

export const create = mutation({
  args: {
    threadId: v.id("threads"),
    msgId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    callback: v.optional(v.string()),
    handler: v.optional(v.string()),
    retry: v.optional(v.any()),
    args: v.any(),
    saveDelta: v.boolean(),
  },
  returns: vToolCallDoc,
  handler: async (ctx, args) => {
    const toolCall = await createToolCallRecord(ctx, {
      threadId: args.threadId,
      msgId: args.msgId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      callback: args.callback,
      handler: args.handler,
      retry: normalizeSyncToolRetryPolicy(args.retry),
      args: args.args,
      saveDelta: args.saveDelta,
    });
    return publicToolCall(toolCall);
  },
});

export const setResult = mutation({
  args: {
    id: v.id("tool_calls"),
    result: v.any(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db.get(args.id);
    if (!toolCall) {
      throw new Error(`Tool call ${args.id} not found`);
    }
    if (toolCall.status !== "pending") {
      logger.warn(`setResult: skipping overwrite for callId=${toolCall.toolCallId}, currentStatus=${toolCall.status}`);
      return false;
    }
    logger.debug(`setResult: callId=${toolCall.toolCallId}, tool=${toolCall.toolName}`);
    await cleanupTimeoutFn(ctx, toolCall);
    await cleanupExecutionRetryFn(ctx, toolCall);
    await ctx.db.patch(args.id, {
      result: args.result,
      status: "completed",
      executionRetryFnId: undefined,
      nextRetryAt: undefined,
    });
    return true;
  },
});

export const setError = mutation({
  args: {
    id: v.id("tool_calls"),
    error: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db.get(args.id);
    if (!toolCall) {
      throw new Error(`Tool call ${args.id} not found`);
    }
    if (toolCall.status !== "pending") {
      logger.warn(`setError: skipping overwrite for callId=${toolCall.toolCallId}, currentStatus=${toolCall.status}`);
      return false;
    }
    logger.debug(`setError: callId=${toolCall.toolCallId}, tool=${toolCall.toolName}, error=${args.error}`);
    await cleanupTimeoutFn(ctx, toolCall);
    await cleanupExecutionRetryFn(ctx, toolCall);
    await ctx.db.patch(args.id, {
      error: args.error,
      status: "failed",
      callbackLastError: args.error,
      executionRetryFnId: undefined,
      nextRetryAt: undefined,
    });
    return true;
  },
});

export const setToolCallTimeout = mutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    timeout: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
      .unique();
    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found for thread ${args.threadId}`);
    }
    if (toolCall.status !== "pending") {
      throw new Error(`Tool call ${args.toolCallId} is not pending`);
    }

    await cleanupTimeoutFn(ctx, toolCall);

    if (args.timeout === null) {
      await ctx.db.patch(toolCall._id, {
        timeoutMs: null,
        expiresAt: null,
      });
      logger.debug(`setToolCallTimeout: disabled timeout for callId=${args.toolCallId}`);
      return null;
    }

    const timeoutMs = normalizeToolCallTimeoutMs(args.timeout);
    const expiresAt = Date.now() + timeoutMs;
    const timeoutFnId = await ctx.scheduler.runAfter(timeoutMs, internal.tool_calls.failPendingToolCall, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });

    await ctx.db.patch(toolCall._id, {
      timeoutMs,
      expiresAt,
      timeoutFnId,
    });
    logger.debug(`setToolCallTimeout: set timeout=${timeoutMs}ms for callId=${args.toolCallId}`);
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
      .withIndex("by_status", (q) => q.eq("threadId", args.threadId).eq("status", "pending"))
      .collect();
    return toolCalls.map(publicToolCall);
  },
});

export const getByToolCallId = query({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
  },
  returns: v.union(vToolCallDoc, v.null()),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
      .unique();
    if (!toolCall) {
      return null;
    }
    return publicToolCall(toolCall);
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
    retry: v.optional(v.any()),
    saveDelta: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get thread to access workpool config
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    logger.debug(`scheduleToolCall: tool=${args.toolName}, callId=${args.toolCallId}, thread=${args.threadId}`);

    // Create the tool call record
    await createToolCallRecord(ctx, {
      threadId: args.threadId,
      msgId: args.msgId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      handler: args.handler,
      retry: normalizeSyncToolRetryPolicy(args.retry),
      args: args.args,
      saveDelta: args.saveDelta,
    });

    // Use tool execution workpool if specified, otherwise fall back to general workpool
    const workpoolHandle = thread.toolExecutionWorkpoolEnqueueAction ?? thread.workpoolEnqueueAction;
    logger.debug(`scheduleToolCall: enqueuing execution for callId=${args.toolCallId} (workpool=${!!workpoolHandle})`);

    // Schedule the tool execution (via workpool if configured)
    await enqueueAction(ctx, workpoolHandle, internal.tool_calls.executeToolCall, {
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
    saveDelta: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Get thread to access workpool config
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }

    logger.debug(`scheduleAsyncToolCall: tool=${args.toolName}, callId=${args.toolCallId}, thread=${args.threadId}`);

    // Create the tool call record (will remain pending until addToolResult is called)
    await createToolCallRecord(ctx, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      msgId: args.msgId,
      toolName: args.toolName,
      callback: args.callback,
      args: args.args,
      saveDelta: args.saveDelta,
    });

    // Use tool execution workpool if specified, otherwise fall back to general workpool
    const workpoolHandle = thread.toolExecutionWorkpoolEnqueueAction ?? thread.workpoolEnqueueAction;
    logger.debug(
      `scheduleAsyncToolCall: enqueuing callback for callId=${args.toolCallId} (workpool=${!!workpoolHandle})`,
    );

    // Schedule the callback to notify the user (via workpool if configured) - it does NOT return the result
    await enqueueAction(ctx, workpoolHandle, internal.tool_calls.executeAsyncToolCallback, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      args: args.args,
      callback: args.callback,
      attempt: 1,
    });

    return null;
  },
});

export const updateExecutionRetryState = internalMutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    executionAttempt: v.number(),
    executionLastError: v.optional(v.string()),
    nextRetryAt: v.optional(v.number()),
    executionRetryFnId: v.optional(v.id("_scheduled_functions")),
    clearNextRetryAt: v.optional(v.boolean()),
    clearExecutionRetryFnId: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await getToolCallByScope(ctx, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });
    if (!toolCall || toolCall.status !== "pending") {
      return null;
    }

    const patch: {
      executionAttempt: number;
      executionLastError?: string;
      nextRetryAt?: number | undefined;
      executionRetryFnId?: Id<"_scheduled_functions"> | undefined;
    } = {
      executionAttempt: args.executionAttempt,
    };
    if (args.executionLastError !== undefined) {
      patch.executionLastError = args.executionLastError;
    }
    if (args.nextRetryAt !== undefined) {
      patch.nextRetryAt = args.nextRetryAt;
    }
    if (args.executionRetryFnId !== undefined) {
      patch.executionRetryFnId = args.executionRetryFnId;
    }
    if (args.clearNextRetryAt) {
      patch.nextRetryAt = undefined;
    }
    if (args.clearExecutionRetryFnId) {
      patch.executionRetryFnId = undefined;
    }
    await ctx.db.patch(toolCall._id, patch);
    return null;
  },
});

export const scheduleExecutionRetry = internalMutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    handler: v.string(),
    executionAttempt: v.number(),
    executionLastError: v.string(),
    nextRetryAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await getToolCallByScope(ctx, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });
    if (!toolCall || toolCall.status !== "pending") {
      return null;
    }

    await cleanupExecutionRetryFn(ctx, toolCall);
    const delayMs = Math.max(0, args.nextRetryAt - Date.now());
    const executionRetryFnId = await ctx.scheduler.runAfter(delayMs, internal.tool_calls.executeToolCall, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      handler: args.handler,
    });

    await ctx.db.patch(toolCall._id, {
      executionAttempt: args.executionAttempt,
      executionLastError: args.executionLastError,
      nextRetryAt: args.nextRetryAt,
      executionRetryFnId,
    });
    return null;
  },
});

export const resumePendingSyncToolExecutions = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.floor(args.limit ?? 100));
    const pending = await ctx.db
      .query("tool_calls")
      .withIndex("by_status_only", (q) => q.eq("status", "pending"))
      .take(limit * 2);

    let resumed = 0;
    const now = Date.now();
    for (const toolCall of pending) {
      if (resumed >= limit) {
        break;
      }
      if (!toolCall.handler) {
        continue;
      }
      if (toolCall.executionRetryFnId) {
        const retryFn = await ctx.db.system.get(toolCall.executionRetryFnId);
        if (retryFn?.state.kind === "pending") {
          continue;
        }
      }
      const nextRetryAt = toolCall.nextRetryAt ?? now;
      const delayMs = Math.max(0, nextRetryAt - now);
      const executionRetryFnId = await ctx.scheduler.runAfter(delayMs, internal.tool_calls.executeToolCall, {
        threadId: toolCall.threadId,
        toolCallId: toolCall.toolCallId,
        handler: toolCall.handler,
      });
      await ctx.db.patch(toolCall._id, {
        executionRetryFnId,
      });
      resumed += 1;
    }

    if (resumed > 0) {
      logger.warn(`resumePendingSyncToolExecutions: resumed ${resumed} pending sync tool call(s)`);
    }
    return resumed;
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
    const toolCall = await ctx.runQuery(api.tool_calls.getByToolCallId, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });

    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }
    if (toolCall.status !== "pending") {
      logger.debug(`executeToolCall: skipping callId=${args.toolCallId}, status already terminal (${toolCall.status})`);
      return null;
    }
    logger.debug(`executeToolCall: tool=${toolCall.toolName}`);

    const thread = await ctx.runQuery(api.threads.get, {
      threadId: args.threadId,
    });
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    if (thread.stopSignal || thread.status === "stopped") {
      await ctx.runMutation(api.tool_calls.addToolError, {
        threadId: args.threadId,
        toolCallId: toolCall.toolCallId,
        error: "Tool execution cancelled because the thread was stopped",
      });
      return null;
    }

    const handler = toolCall.handler ?? args.handler;
    const retryPolicy = normalizeSyncToolRetryPolicy(toolCall.executionRetryPolicy);
    const retryEnabled = retryPolicy?.enabled === true;
    const maxAttempts = retryEnabled ? Math.max(1, retryPolicy.maxAttempts ?? SYNC_TOOL_MAX_ATTEMPTS) : 1;
    const toolArgs = typeof toolCall.args === "object" && toolCall.args !== null ? toolCall.args : {};
    const attempt = Math.max(1, (toolCall.executionAttempt ?? 0) + 1);
    await ctx.runMutation(internal.tool_calls.updateExecutionRetryState, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
      executionAttempt: attempt,
      clearNextRetryAt: true,
      clearExecutionRetryFnId: true,
    });
    logger.debug(
      `executeToolCall: callId=${args.toolCallId}, thread=${args.threadId}, attempt=${attempt}/${maxAttempts}`,
    );

    try {
      logger.debug(`executeToolCall: invoking handler for callId=${args.toolCallId}`);
      const result = await ctx.runAction(handler as FunctionHandle<"action">, toolArgs as Record<string, unknown>);
      logger.debug(`executeToolCall: handler succeeded for callId=${args.toolCallId}`);
      await ctx.runMutation(api.tool_calls.addToolResult, {
        threadId: args.threadId,
        result,
        toolCallId: toolCall.toolCallId,
      });
      return null;
    } catch (e) {
      const errorInfo = extractToolErrorInfo(e);
      const error = errorInfo.message;
      logger.debug(`executeToolCall: handler failed for callId=${args.toolCallId} (attempt=${attempt}): ${error}`);

      let retryable = false;
      if (retryEnabled) {
        if (retryPolicy.shouldRetryError) {
          try {
            const decision = await ctx.runAction(retryPolicy.shouldRetryError as FunctionHandle<"action">, {
              threadId: args.threadId,
              toolCallId: args.toolCallId,
              toolName: toolCall.toolName,
              args: toolCall.args,
              error,
              attempt,
              maxAttempts,
            });
            retryable = isRetryableDecision(decision);
          } catch (classifierError) {
            logger.warn(
              `executeToolCall: shouldRetryError failed for callId=${args.toolCallId}, falling back to default classifier: ${
                classifierError instanceof Error ? classifierError.message : String(classifierError)
              }`,
            );
            retryable = isRetryableToolErrorDefault(errorInfo);
          }
        } else {
          retryable = isRetryableToolErrorDefault(errorInfo);
        }
      }

      if (retryEnabled && retryable && attempt < maxAttempts) {
        const delayMs = computeRetryDelayMs(attempt, retryPolicy.backoff);
        const nextRetryAt = Date.now() + delayMs;
        await ctx.runMutation(internal.tool_calls.scheduleExecutionRetry, {
          threadId: args.threadId,
          toolCallId: args.toolCallId,
          handler,
          executionAttempt: attempt,
          executionLastError: error,
          nextRetryAt,
        });
        logger.warn(
          `executeToolCall: scheduled retry for callId=${args.toolCallId} in ${delayMs}ms (attempt ${
            attempt + 1
          }/${maxAttempts})`,
        );
        return null;
      }

      await ctx.runMutation(internal.tool_calls.updateExecutionRetryState, {
        threadId: args.threadId,
        toolCallId: args.toolCallId,
        executionAttempt: attempt,
        executionLastError: error,
        clearNextRetryAt: true,
        clearExecutionRetryFnId: true,
      });
      await ctx.runMutation(api.tool_calls.addToolError, {
        threadId: args.threadId,
        error,
        toolCallId: toolCall.toolCallId,
      });
      return null;
    }
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
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 1;
    logger.debug(
      `executeAsyncToolCallback: tool=${args.toolName}, callId=${args.toolCallId}, thread=${args.threadId}, attempt=${attempt}`,
    );
    try {
      // Call the callback with the tool call info - it does NOT return the result
      await ctx.runAction(args.callback as FunctionHandle<"action">, {
        threadId: args.threadId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        args: args.args,
      });
      logger.debug(`executeAsyncToolCallback: callback succeeded for callId=${args.toolCallId} (attempt=${attempt})`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`Async tool callback error for callId=${args.toolCallId} (attempt=${attempt}):`, error);
      await ctx.runMutation(internal.tool_calls.onAsyncCallbackFailure, {
        threadId: args.threadId,
        toolCallId: args.toolCallId,
        error,
        attempt,
      });
    }

    return null;
  },
});

export const onAsyncCallbackFailure = internalMutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    error: v.string(),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
      .unique();
    if (!toolCall || toolCall.status !== "pending") {
      return null;
    }

    const attempt = Math.max(args.attempt, toolCall.callbackAttempt ?? 0);
    await ctx.db.patch(toolCall._id, {
      callbackAttempt: attempt,
      callbackLastError: args.error,
    });

    if (attempt >= ASYNC_CALLBACK_MAX_ATTEMPTS) {
      const finalError = `Async callback failed after ${attempt} attempts: ${args.error}`;
      logger.error(`onAsyncCallbackFailure: exhausting retries for callId=${args.toolCallId}: ${finalError}`);
      await failToolCallIfPending(ctx, toolCall, finalError);
      return null;
    }

    if (!toolCall.callback) {
      const finalError = `Async callback handle missing for callId=${args.toolCallId}`;
      logger.error(`onAsyncCallbackFailure: ${finalError}`);
      await failToolCallIfPending(ctx, toolCall, finalError);
      return null;
    }

    const nextAttempt = attempt + 1;
    const delayMs = ASYNC_CALLBACK_RETRY_BASE_MS * 2 ** (attempt - 1);
    logger.warn(
      `onAsyncCallbackFailure: retrying callId=${args.toolCallId} in ${delayMs}ms (attempt ${nextAttempt}/${ASYNC_CALLBACK_MAX_ATTEMPTS})`,
    );
    await ctx.scheduler.runAfter(delayMs, internal.tool_calls.executeAsyncToolCallback, {
      threadId: toolCall.threadId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      args: toolCall.args,
      callback: toolCall.callback,
      attempt: nextAttempt,
    });

    return null;
  },
});

export const failPendingToolCall = internalMutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await ctx.db
      .query("tool_calls")
      .withIndex("by_thread_tool_call_id", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
      .unique();
    if (!toolCall || toolCall.status !== "pending") {
      return null;
    }
    if (toolCall.expiresAt == null) {
      return null;
    }
    if (Date.now() < toolCall.expiresAt) {
      return null;
    }

    const timeoutMs = toolCall.timeoutMs ?? TOOL_CALL_TIMEOUT_MS;
    const error = `Tool call timed out after ${formatTimeoutMs(timeoutMs)}`;
    const timedOut = await failToolCallIfPending(ctx, toolCall, error);
    if (timedOut) {
      logger.warn(`failPendingToolCall: timed out callId=${args.toolCallId}`);
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
    logger.debug(`onToolComplete: thread=${args.threadId}`);

    // Check thread status
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error(`Thread ${args.threadId} not found`);
    }
    logger.debug(`onToolComplete: thread status=${thread.status}, stopSignal=${!!thread.stopSignal}`);

    // Check stop signal
    if (thread.stopSignal) {
      const previousStatus = thread.status;
      const activeStreamId = thread.activeStream ?? null;
      logger.debug(
        `onToolComplete: stop signal detected, transitioning thread to stopped and clearing active stream=${activeStreamId ?? "none"}`,
      );
      await ctx.db.patch(args.threadId, {
        status: "stopped",
        activeStream: null,
        continue: false,
        retryState: undefined,
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
        if (activeStream && (activeStream.state.kind === "pending" || activeStream.state.kind === "streaming")) {
          await ctx.runMutation(api.streams.abort, {
            streamId: activeStreamId,
            reason: "stopSignal",
          });
        }
      }
      return null;
    }

    // Check for pending tool calls
    const pending = await ctx.runQuery(api.tool_calls.listPending, {
      threadId: args.threadId,
    });

    if (pending.length === 0) {
      const activeStream = thread.activeStream ? await ctx.db.get(thread.activeStream) : null;
      if (isAlive(activeStream)) {
        logger.debug("onToolComplete: all tool calls complete, active stream still alive, setting continue flag");
        await ctx.db.patch(args.threadId, { continue: true });
      } else {
        logger.debug("onToolComplete: all tool calls complete, scheduling continueStream");
        // All tool calls complete - schedule continuation
        await ctx.scheduler.runAfter(0, api.agent.continueStream, {
          threadId: args.threadId,
        });
      }
    } else {
      logger.debug(`onToolComplete: ${pending.length} tool calls still pending`);
    }

    return null;
  },
});

type CompletedToolCall = Doc<"tool_calls">;

export function createToolOutcomePart(
  toolCall: CompletedToolCall,
  pendingPart?: { toolCallId: string; callProviderMetadata?: unknown },
): UIMessagePart<any, any> | null {
  if (toolCall.status === "pending") {
    return null;
  }
  const part: UIMessagePart<any, any> =
    toolCall.status === "failed"
      ? {
          type: `tool-${toolCall.toolName}`,
          toolCallId: toolCall.toolCallId,
          state: "output-error",
          input: toolCall.args ?? {},
          errorText: toolCall.error ?? "Unknown error",
        }
      : {
          type: `tool-${toolCall.toolName}`,
          toolCallId: toolCall.toolCallId,
          state: "output-available",
          input: toolCall.args ?? {},
          output: toolCall.result ?? null,
        };

  if (pendingPart?.callProviderMetadata != null) {
    part.callProviderMetadata = pendingPart.callProviderMetadata as ProviderMetadata;
  }
  return part;
}

/**
 * Add a tool result for an async tool call.
 * This is called by the user after they have the result for an async tool.
 */
export const addToolResult = mutation({
  args: {
    threadId: v.id("threads"),
    toolCallId: v.string(),
    result: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toolCall = await getToolCallByScope(ctx, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });

    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }

    const threadId = toolCall.threadId;
    if (toolCall.status !== "pending") {
      logger.warn(`addToolResult: ignoring duplicate completion for callId=${args.toolCallId}`);
      return null;
    }

    logger.debug(`addToolResult: callId=${args.toolCallId}, tool=${toolCall.toolName}, thread=${threadId}`);

    // Update the tool call record with the result
    const transitioned = await ctx.runMutation(api.tool_calls.setResult, {
      id: toolCall._id,
      result: args.result,
    });
    if (!transitioned) {
      logger.warn(`addToolResult: skipped duplicate completion race for callId=${args.toolCallId}`);
      return null;
    }

    if (toolCall.saveDelta) {
      logger.debug(`addToolResult: inserting tool outcome delta for callId=${args.toolCallId}`);
      await ctx.runMutation(internal.streams.insertToolCallOutcomeDelta, {
        threadId: threadId,
        msgId: toolCall.msgId,
        toolOutcomePart: {
          toolCallId: toolCall.toolCallId,
          type: "tool-output-available",
          output: args.result,
        },
      });
    }

    // Check if all tool calls are complete and continue if so
    await ctx.runMutation(internal.tool_calls.onToolComplete, {
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
    threadId: v.id("threads"),
    toolCallId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Find the tool call record
    const toolCall = await getToolCallByScope(ctx, {
      threadId: args.threadId,
      toolCallId: args.toolCallId,
    });

    if (!toolCall) {
      throw new Error(`Tool call ${args.toolCallId} not found`);
    }

    const threadId = toolCall.threadId;

    if (toolCall.status !== "pending") {
      logger.warn(`addToolError: ignoring duplicate completion for callId=${args.toolCallId}`);
      return null;
    }

    logger.debug(
      `addToolError: callId=${args.toolCallId}, tool=${toolCall.toolName}, thread=${threadId}, error=${args.error}`,
    );

    // Update the tool call record with the error
    const transitioned = await ctx.runMutation(api.tool_calls.setError, {
      id: toolCall._id,
      error: args.error,
    });
    if (!transitioned) {
      logger.warn(`addToolError: skipped duplicate completion race for callId=${args.toolCallId}`);
      return null;
    }

    if (toolCall.saveDelta) {
      logger.debug(`addToolError: inserting tool outcome delta for callId=${args.toolCallId}`);
      await ctx.runMutation(internal.streams.insertToolCallOutcomeDelta, {
        threadId: threadId,
        msgId: toolCall.msgId,
        toolOutcomePart: {
          toolCallId: toolCall.toolCallId,
          type: "tool-output-error",
          errorText: args.error || "Unknown error",
        },
      });
    }

    // Check if all tool calls are complete and continue if so
    await ctx.runMutation(internal.tool_calls.onToolComplete, {
      threadId: threadId,
    });

    return null;
  },
});
