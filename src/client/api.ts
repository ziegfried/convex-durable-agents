import type { UIMessage } from "ai";
import {
  actionGeneric,
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { type Infer, v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";
import { vUIMessageOptId } from "../component/messages.js";
import { vMessageContent, vMessageRole } from "../component/schema.js";
import type { StreamingMessageUpdates } from "../component/streams.js";
import {
  _vClientThreadDoc,
  type ActionCtx,
  type MessageDoc,
  type MutationCtx,
  type QueryCtx,
  type ThreadDoc,
} from "./types.js";

// ============================================================================
// Agent API Definition
// ============================================================================

async function checkThreadIsIdle(component: ComponentApi, ctx: MutationCtx, threadId: Id<"threads">) {
  const thread = await ctx.runQuery(component.threads.get, { threadId });
  if (!thread) {
    throw new Error(`Thread ${threadId} not found`);
  }
  if (thread.retryState) {
    throw new Error(`Thread ${threadId} has retry pending; stop the thread to interrupt the retry flow`);
  }
  switch (thread.status) {
    case "awaiting_tool_results":
    case "streaming":
      throw new Error(`Thread ${threadId} status=${thread.status}, cannot resume`);
  }
}

async function assertNoRetryPending(component: ComponentApi, ctx: MutationCtx, threadId: Id<"threads">): Promise<void> {
  const thread = await ctx.runQuery(component.threads.get, { threadId });
  if (!thread) {
    throw new Error(`Thread ${threadId} not found`);
  }
  if (thread.retryState) {
    throw new Error(`Thread ${threadId} has retry pending; stop the thread to interrupt the retry flow`);
  }
}

export type StreamArgs = { kind: "list" } | { kind: "deltas"; cursors: Array<{ streamId: string; cursor: number }> };

export type StreamMessage = {
  streamId: string;
  status: "streaming" | "finished" | "aborted";
  msgId: string;
  threadId: string;
  _creationTime: number;
  baseMessageCreationTime?: number;
  streamVersion: number;
};

export type StreamDelta = {
  streamId: string;
  seq: number;
  start: number;
  end: number;
  parts: Array<unknown>;
  _creationTime: number;
  messageId?: string;
  chunkCount: number;
  schemaVersion: number;
  ops?: Array<{
    op: "append_part" | "replace_tool_call_part" | "skip_duplicate_step_start" | "skip_tail_duplicate_text";
    partType?: string;
    toolCallId?: string;
    targetPartKey?: string;
    targetIndexHint?: number;
    reason?: string;
  }>;
};

export type MessagesWithStreamsResult = {
  messages: MessageDoc[];
  streams?: { kind: "list"; messages: StreamMessage[] } | { kind: "deltas"; deltas: StreamDelta[] };
};

export type AgentApi<V extends FunctionVisibility = "public"> = {
  createThread: RegisteredMutation<V, { prompt?: string }, string>;
  sendMessage: RegisteredMutation<V, { threadId: string; prompt: string }, null>;
  addMessage: RegisteredMutation<V, { threadId: string; msg: Infer<typeof vUIMessageOptId> }, null>;
  resumeThread: RegisteredMutation<V, { threadId: string; prompt?: string }, null>;
  stopThread: RegisteredMutation<V, { threadId: string }, null>;
  getThread: RegisteredQuery<V, { threadId: string }, ThreadDoc | null>;
  listMessages: RegisteredQuery<V, { threadId: string }, MessageDoc[]>;
  streamUpdates: RegisteredQuery<V, { threadId: string; fromSeq?: number }, StreamingMessageUpdates>;
  listThreads: RegisteredQuery<V, { limit?: number }, ThreadDoc[]>;
  deleteThread: RegisteredMutation<V, { threadId: string }, null>;
  addToolResult: RegisteredMutation<V, { threadId: string; toolCallId: string; result: unknown }, null>;
  addToolError: RegisteredMutation<V, { threadId: string; toolCallId: string; error: string }, null>;
};

export type AgentApiOptions = {
  /** Optional authorization callback for thread access control */
  authorizationCallback?: (ctx: QueryCtx | MutationCtx | ActionCtx, threadId: string) => Promise<void> | void;
  /** Optional: Function to enqueue actions via workpool (used for both stream handler and tools unless overridden) */
  workpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
  /** Optional: Override workpool for tool execution only */
  toolExecutionWorkpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
  /** Optional: Callback invoked when thread status changes */
  onStatusChange?: FunctionReference<"mutation", "internal">;
  /** Optional: Whether to exclude system messages from message lists */
  excludeSystemMessages?: boolean;
};

async function serializeThreadOptions(options?: AgentApiOptions): Promise<{
  workpoolEnqueueAction?: string;
  toolExecutionWorkpoolEnqueueAction?: string;
  onStatusChangeHandle?: string;
}> {
  const result: {
    workpoolEnqueueAction?: string;
    toolExecutionWorkpoolEnqueueAction?: string;
    onStatusChangeHandle?: string;
  } = {};
  if (options?.workpoolEnqueueAction) {
    const handle = await createFunctionHandle(options.workpoolEnqueueAction);
    result.workpoolEnqueueAction = handle.toString();
  }
  if (options?.toolExecutionWorkpoolEnqueueAction) {
    const handle = await createFunctionHandle(options.toolExecutionWorkpoolEnqueueAction);
    result.toolExecutionWorkpoolEnqueueAction = handle.toString();
  }
  if (options?.onStatusChange) {
    const handle = await createFunctionHandle(options.onStatusChange);
    result.onStatusChangeHandle = handle.toString();
  }
  return result;
}

function createAgentApi(
  component: ComponentApi,
  ref: FunctionReference<"action", "internal" | "public", { threadId: string }>,
  _action: typeof actionGeneric | typeof internalActionGeneric,
  query: typeof queryGeneric | typeof internalQueryGeneric,
  mutation: typeof mutationGeneric | typeof internalMutationGeneric,
  options?: AgentApiOptions,
) {
  const authorize = options?.authorizationCallback;

  return {
    createThread: mutation({
      args: {
        prompt: v.optional(v.string()),
        messages: v.optional(v.array(v.object({ role: vMessageRole, content: vMessageContent }))),
        autoStart: v.optional(v.boolean()),
      },
      returns: v.string(),
      handler: async (ctx, args) => {
        // Create a function handle that can be scheduled from within the component
        const handle = await createFunctionHandle(ref);

        // Serialize thread options (workpool + status callback)
        const serializedOptions = await serializeThreadOptions(options);

        const thread = await ctx.runMutation(component.threads.create, {
          streamFnHandle: handle,
          ...serializedOptions,
        });

        if (args.messages) {
          for (const message of args.messages) {
            await ctx.runMutation(component.messages.add, {
              threadId: thread._id as Id<"threads">,
              msg: {
                role: message.role,
                parts: message.content,
              } as UIMessage,
            });
          }
        }

        if (args.prompt) {
          await ctx.runMutation(component.messages.add, {
            threadId: thread._id as Id<"threads">,
            msg: { role: "user", parts: [{ type: "text", text: args.prompt }] },
          });
        }

        if (args.autoStart || (args.autoStart == null && args.prompt != null)) {
          await ctx.runMutation(component.agent.continueStream, {
            threadId: thread._id as Id<"threads">,
          });
        }

        return thread._id;
      },
    }),
    sendMessage: mutation({
      args: {
        threadId: v.string(),
        prompt: v.string(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        if (authorize) await authorize(ctx, args.threadId);
        const threadId = args.threadId as Id<"threads">;
        await assertNoRetryPending(component, ctx, threadId);
        await ctx.runMutation(component.messages.add, {
          threadId,
          msg: { role: "user", parts: [{ type: "text", text: args.prompt }] },
        });
        await ctx.runMutation(component.threads.resume, {
          threadId,
        });
        await ctx.scheduler.runAfter(0, component.agent.continueStream, {
          threadId,
        });
        return null;
      },
    }),
    addMessage: mutation({
      args: {
        threadId: v.string(),
        msg: vUIMessageOptId,
      },
      returns: v.union(v.string(), v.null()),
      handler: async (ctx, args) => {
        if (authorize) await authorize(ctx, args.threadId);
        const msgId = await ctx.runMutation(component.messages.add, {
          threadId: args.threadId,
          msg: args.msg,
          overwrite: false,
        });
        return msgId ?? null;
      },
    }),
    resumeThread: mutation({
      args: {
        threadId: v.string(),
        prompt: v.optional(v.string()),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        if (authorize) await authorize(ctx, args.threadId);
        const threadId = args.threadId as Id<"threads">;
        await assertNoRetryPending(component, ctx, threadId);
        if (args.prompt) {
          await ctx.runMutation(component.messages.add, {
            threadId,
            msg: { role: "user", parts: [{ type: "text", text: args.prompt }] },
          });
        } else {
          await checkThreadIsIdle(component, ctx, threadId);
        }
        await ctx.runMutation(component.threads.setStopSignal, {
          threadId,
          stopSignal: false,
        });
        await ctx.scheduler.runAfter(0, component.agent.continueStream, {
          threadId,
        });
        return null;
      },
    }),
    stopThread: mutation({
      args: {
        threadId: v.string(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        if (authorize) await authorize(ctx, args.threadId);
        const threadId = args.threadId as Id<"threads">;
        await ctx.runMutation(component.threads.setStopSignal, {
          threadId,
          stopSignal: true,
        });
        await ctx.runMutation(component.threads.clearRetryState, {
          threadId,
        });
        return null;
      },
    }),
    getThread: query({
      args: {
        threadId: v.string(),
      },
      returns: v.union(_vClientThreadDoc, v.null()),
      handler: async (ctx, args) => {
        if (authorize) await authorize(ctx, args.threadId);
        return ctx.runQuery(component.threads.get, {
          threadId: args.threadId as Id<"threads">,
        });
      },
    }),
    listMessages: query({
      args: {
        threadId: v.string(),
      },
      handler: async (ctx, args): Promise<MessageDoc[]> => {
        if (authorize) await authorize(ctx, args.threadId);
        const messages = await ctx.runQuery(component.messages.list, {
          threadId: args.threadId as Id<"threads">,
          excludeSystemMessages: options?.excludeSystemMessages ?? true,
        });
        return messages;
      },
    }),
    streamUpdates: query({
      args: {
        threadId: v.string(),
        fromSeq: v.optional(v.number()),
      },
      handler: async (ctx, args): Promise<StreamingMessageUpdates> => {
        return ctx.runQuery(component.streams.queryStreamingMessageUpdates, {
          threadId: args.threadId as Id<"threads">,
          fromSeq: args.fromSeq,
        });
      },
    }),
    listThreads: query({
      args: {
        limit: v.optional(v.number()),
      },
      handler: async (ctx, args): Promise<ThreadDoc[]> => {
        return ctx.runQuery(component.threads.list, { limit: args.limit });
      },
    }),
    deleteThread: mutation({
      args: {
        threadId: v.string(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        if (authorize) await authorize(ctx, args.threadId);
        await ctx.runMutation(component.threads.remove, {
          threadId: args.threadId,
        });
        return null;
      },
    }),
    addToolResult: mutation({
      args: {
        threadId: v.string(),
        toolCallId: v.string(),
        result: v.any(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        await ctx.runMutation(component.tool_calls.addToolResult, {
          threadId: args.threadId,
          toolCallId: args.toolCallId,
          result: args.result,
        });
        return null;
      },
    }),
    addToolError: mutation({
      args: {
        threadId: v.string(),
        toolCallId: v.string(),
        error: v.string(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        await ctx.runMutation(component.tool_calls.addToolError, {
          threadId: args.threadId,
          toolCallId: args.toolCallId,
          error: args.error,
        });
        return null;
      },
    }),
  };
}

/**
 * Define a public agent API that can be called from clients.
 */
export function defineAgentApi(
  component: ComponentApi,
  ref: FunctionReference<"action", "internal" | "public", { threadId: string }>,
  options?: AgentApiOptions,
): AgentApi<"public"> {
  return createAgentApi(component, ref, actionGeneric, queryGeneric, mutationGeneric, options) as AgentApi<"public">;
}

/**
 * Define an internal agent API that can only be called from other Convex functions.
 */
export function defineInternalAgentApi(
  component: ComponentApi,
  ref: FunctionReference<"action", "internal" | "public", { threadId: string }>,
  options?: AgentApiOptions,
): AgentApi<"internal"> {
  return createAgentApi(
    component,
    ref,
    internalActionGeneric,
    internalQueryGeneric,
    internalMutationGeneric,
    options,
  ) as AgentApi<"internal">;
}
