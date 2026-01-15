import { jsonSchema, type ModelMessage, streamText, type Tool, tool } from "ai";
import {
  actionGeneric,
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  type RegisteredAction,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";

// ============================================================================
// Types
// ============================================================================

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction" | "storage" | "auth" | "scheduler"
>;

export type PaginationOpts = {
  numItems: number;
  cursor: string | null;
  id?: number;
};

export type PaginationResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
};

export type ThreadStatus = "streaming" | "awaiting_tool_results" | "completed" | "failed" | "stopped";

export type ThreadDoc = {
  _id: string;
  _creationTime: number;
  status: ThreadStatus;
  stopSignal: boolean;
  streamId?: string | null;
  streamFnHandle: string;
};

const vThreadStatus = v.union(
  v.literal("streaming"),
  v.literal("awaiting_tool_results"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

const vClientThreadDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  status: vThreadStatus,
  stopSignal: v.boolean(),
  streamId: v.optional(v.union(v.string(), v.null())),
  streamFnHandle: v.string(),
  workpoolEnqueueAction: v.optional(v.string()),
  toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
});

export type MessageDoc = {
  _id: string;
  _creationTime: number;
  threadId: string;
  order: number;
  message: {
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<unknown>;
  };
};

// Sync durable tool definition - handler returns the result directly
export type SyncTool<INPUT = unknown, OUTPUT = unknown> = {
  type: "sync";
  description: string;
  parameters: unknown; // JSON Schema
  handler: FunctionReference<"action", "internal" | "public">;
  _inputType?: INPUT;
  _outputType?: OUTPUT;
};

// Async durable tool definition - callback is notified, result provided later via addToolResult
export type AsyncTool<INPUT = unknown> = {
  type: "async";
  description: string;
  parameters: unknown; // JSON Schema
  callback: FunctionReference<"action", "internal" | "public">;
  _inputType?: INPUT;
};

// Union of sync and async tools
export type DurableTool<INPUT = unknown, OUTPUT = unknown> = SyncTool<INPUT, OUTPUT> | AsyncTool<INPUT>;

// Arguments passed to async tool callbacks
export type AsyncToolCallbackArgs<INPUT = unknown> = {
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: INPUT;
};

// ============================================================================
// Tool Definition Helpers
// ============================================================================

/**
 * Create a sync durable tool definition - the handler returns the result directly
 */
export function createActionTool<INPUT, OUTPUT>(def: {
  description: string;
  args: z.ZodType<INPUT>;
  handler: FunctionReference<"action", "internal" | "public">;
}): SyncTool<INPUT, OUTPUT> {
  // Convert the Zod schema to JSON Schema format using Zod v4's native method
  const jsonSchemaObj = z.toJSONSchema(def.args) as Record<string, unknown>;
  // Remove $schema field as Convex doesn't allow fields starting with $
  const { $schema: _, ...cleanSchema } = jsonSchemaObj;
  return {
    type: "sync",
    description: def.description,
    parameters: cleanSchema,
    handler: def.handler,
  };
}

/**
 * Create an async durable tool definition - the callback is notified of the tool call,
 * but does NOT return the result. The result must be provided later via addToolResult().
 */
export function createAsyncTool<INPUT>(def: {
  description: string;
  args: z.ZodType<INPUT>;
  callback: FunctionReference<"action", "internal" | "public">;
}): AsyncTool<INPUT> {
  // Convert the Zod schema to JSON Schema format using Zod v4's native method
  const jsonSchemaObj = z.toJSONSchema(def.args) as Record<string, unknown>;
  // Remove $schema field as Convex doesn't allow fields starting with $
  const { $schema: _, ...cleanSchema } = jsonSchemaObj;
  return {
    type: "async",
    description: def.description,
    parameters: cleanSchema,
    callback: def.callback,
  };
}

// ============================================================================
// Streaming Options
// ============================================================================

export type StreamingOptions = {
  throttleMs?: number;
  returnImmediately?: boolean;
};

const DEFAULT_STREAMING_OPTIONS: StreamingOptions = {
  throttleMs: 250,
  returnImmediately: false,
};

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Recursively serialize an object for Convex storage.
 * Converts Date objects to ISO strings and handles nested objects/arrays.
 */
function serializeForConvex(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForConvex);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = serializeForConvex(val);
    }
    return result;
  }
  return value;
}

// ============================================================================
// DeltaStreamer
// ============================================================================

/**
 * DeltaStreamer for saving streaming deltas to the database.
 * This class manages the lifecycle of a streaming session, batching and throttling
 * delta writes to the database.
 */
export class DeltaStreamer {
  streamId: Id<"streaming_messages"> | undefined;
  #nextParts: Array<unknown> = [];
  #latestWrite = 0;
  #ongoingWrite: Promise<void> | undefined;
  #cursor = 0;
  abortController: AbortController;

  constructor(
    public readonly component: ComponentApi,
    public readonly ctx: ActionCtx,
    private config: {
      throttleMs: number;
      onAsyncAbort: (reason: string) => Promise<void>;
      abortSignal?: AbortSignal;
    },
    private metadata: {
      threadId: Id<"threads">;
      order: number;
      format: "UIMessageChunk" | "TextStreamPart" | undefined;
    },
  ) {
    this.abortController = new AbortController();
    if (config.abortSignal) {
      config.abortSignal.addEventListener("abort", async () => {
        if (this.abortController.signal.aborted) return;
        if (this.streamId) {
          this.abortController.abort();
          await this.#ongoingWrite;
          await this.ctx.runMutation(this.component.streams.abort, {
            streamId: this.streamId,
            reason: "abortSignal",
          });
        }
      });
    }
  }

  #creatingStreamIdPromise: Promise<string> | undefined;

  async getStreamId(): Promise<string> {
    if (this.streamId) return this.streamId;
    if (this.#creatingStreamIdPromise) return this.#creatingStreamIdPromise;
    this.#creatingStreamIdPromise = this.ctx.runMutation(this.component.streams.create, {
      threadId: this.metadata.threadId,
      order: this.metadata.order,
      format: this.metadata.format,
    });
    this.streamId = (await this.#creatingStreamIdPromise) as Id<"streaming_messages">;
    return this.streamId;
  }

  async addParts(parts: Array<unknown>): Promise<void> {
    if (this.abortController.signal.aborted) return;
    await this.getStreamId();
    this.#nextParts.push(...parts);
    if (!this.#ongoingWrite && Date.now() - this.#latestWrite >= this.config.throttleMs) {
      this.#ongoingWrite = this.#sendDelta();
    }
  }

  async consumeStream(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const chunk of stream) {
      await this.addParts([chunk]);
    }
    await this.finish();
  }

  async #sendDelta(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    const delta = this.#createDelta();
    if (!delta) return;
    this.#latestWrite = Date.now();
    try {
      const success = await this.ctx.runMutation(this.component.streams.addDelta, delta);
      if (!success) {
        console.warn("[DeltaStreamer] Delta rejected (stream not active)");
        await this.config.onAsyncAbort("async abort");
        this.abortController.abort();
        return;
      }
    } catch (e) {
      console.error("[DeltaStreamer] Error sending delta:", e);
      await this.config.onAsyncAbort(e instanceof Error ? e.message : "unknown error");
      this.abortController.abort();
      throw e;
    }
    if (this.#nextParts.length > 0 && Date.now() - this.#latestWrite >= this.config.throttleMs) {
      this.#ongoingWrite = this.#sendDelta();
    } else {
      this.#ongoingWrite = undefined;
    }
  }

  #createDelta(): {
    streamId: Id<"streaming_messages">;
    start: number;
    end: number;
    parts: Array<unknown>;
  } | null {
    if (!this.streamId || this.#nextParts.length === 0) return null;
    const parts = this.#nextParts.map(serializeForConvex);
    this.#nextParts = [];
    const start = this.#cursor;
    const end = start + parts.length;
    this.#cursor = end;
    return { streamId: this.streamId, start, end, parts };
  }

  async finish(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    await this.#ongoingWrite;
    const finalDelta = this.#createDelta();
    if (this.streamId) {
      await this.ctx.runMutation(this.component.streams.finish, {
        streamId: this.streamId,
        finalDelta: finalDelta ?? undefined,
      });
    }
  }

  async fail(reason: string): Promise<void> {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort();
    await this.#ongoingWrite;
    const finalDelta = this.#createDelta();
    if (this.streamId) {
      await this.ctx.runMutation(this.component.streams.abort, {
        streamId: this.streamId,
        reason,
        finalDelta: finalDelta ?? undefined,
      });
    }
  }
}

// ============================================================================
// Tool Definition Building
// ============================================================================

// Internal tool definition with serialized function handles
type ToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
} & ({ type: "sync"; handler: string } | { type: "async"; callback: string });

async function buildToolDefinitions(tools: Record<string, DurableTool>): Promise<Array<ToolDefinition>> {
  if (!tools) return [];

  const makeToolDef = async (name: string, tool: DurableTool): Promise<ToolDefinition> => {
    if (tool.type === "sync") {
      return {
        type: "sync",
        name,
        description: tool.description,
        parameters: tool.parameters,
        handler: await serializeFunctionRef(tool.handler),
      };
    }
    return {
      type: "async",
      name,
      description: tool.description,
      parameters: tool.parameters,
      callback: await serializeFunctionRef(tool.callback),
    };
  };

  return await Promise.all(Object.entries(tools).map(([name, tool]) => makeToolDef(name, tool)));
}

/**
 * Serialize a function reference to a string
 */
async function serializeFunctionRef(ref: FunctionReference<"action", "internal" | "public">): Promise<string> {
  const handle = await createFunctionHandle(ref);
  return handle.toString();
}

// ============================================================================
// Stream Handler Action
// ============================================================================

type StreamHandlerArgs = Omit<Parameters<typeof streamText>[0], "tools" | "messages" | "prompt"> & {
  tools: Record<string, DurableTool<unknown, unknown>>;
  /** Optional: Save streaming deltas to the database for real-time client updates */
  saveStreamDeltas?: boolean | StreamingOptions;
  transformMessages?: (messages: ModelMessage[]) => ModelMessage[];
  /** Optional: Function to enqueue actions via workpool (used for both stream handler and tools unless overridden) */
  workpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
  /** Optional: Override workpool for tool execution only */
  toolExecutionWorkpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
};

export function streamHandlerAction(
  component: ComponentApi,
  { tools, saveStreamDeltas, transformMessages = (messages) => messages, ...streamTextArgs }: StreamHandlerArgs,
) {
  return internalActionGeneric({
    args: {
      threadId: v.string(),
      streamId: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      const thread = await ctx.runQuery(component.threads.get, {
        threadId: args.threadId,
      });

      if (thread?.streamId !== args.streamId) {
        throw new Error(`Thread ${args.threadId} streamId mismatch: ${thread?.streamId} !== ${args.streamId}`);
      }

      // Get the current message order for streaming
      const messages = await ctx.runQuery(component.messages.list, {
        threadId: args.threadId,
      });
      const currentOrder = messages.length > 0 ? Math.max(...messages.map((m) => m.order)) + 1 : 0;

      // Set up delta streamer if enabled
      let streamer: DeltaStreamer | undefined;
      if (saveStreamDeltas) {
        const streamingOptions = typeof saveStreamDeltas === "object" ? saveStreamDeltas : DEFAULT_STREAMING_OPTIONS;
        streamer = new DeltaStreamer(
          component,
          ctx as ActionCtx,
          {
            throttleMs: streamingOptions.throttleMs ?? DEFAULT_STREAMING_OPTIONS.throttleMs!,
            onAsyncAbort: async (reason) => {
              console.warn("Stream aborted:", reason);
            },
          },
          {
            threadId: args.threadId as Id<"threads">,
            order: currentOrder,
            format: "TextStreamPart",
          },
        );
      }

      try {
        const toolDefinitions = await buildToolDefinitions(tools);
        const modelMessages = transformMessages(messages.map((m) => m.message as ModelMessage));

        // Build tool definitions for AI SDK (without execute functions)
        const handlerlessTools: Record<string, Tool> = {};
        for (const toolDef of toolDefinitions) {
          handlerlessTools[toolDef.name] = tool({
            description: toolDef.description,
            inputSchema: jsonSchema(toolDef.parameters as Parameters<typeof jsonSchema>[0]),
            // No execute function - we handle tool calls manually
          });
        }

        try {
          // Call streamText
          const result = streamText({
            ...streamTextArgs,
            prompt: undefined,
            messages: modelMessages,
            tools: handlerlessTools,
          });

          // Consume the stream
          const assistantContent: Array<unknown> = [];
          let finishReason: string | undefined;
          const toolCalls: Array<{
            toolCallId: string;
            toolName: string;
            args: unknown;
          }> = [];

          for await (const part of result.fullStream) {
            // Send delta to streamer if enabled
            if (streamer) {
              await streamer.addParts([part]);
            }

            switch (part.type) {
              case "text-delta": {
                // Accumulate text
                const lastPart =
                  assistantContent.length > 0 ? assistantContent[assistantContent.length - 1] : undefined;
                if (lastPart && typeof lastPart === "object" && (lastPart as { type: string }).type === "text") {
                  (lastPart as { text: string }).text += part.text;
                } else {
                  assistantContent.push({ type: "text", text: part.text });
                }
                break;
              }
              case "tool-call":
                assistantContent.push({
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });
                toolCalls.push({
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.input,
                });
                break;
              case "finish":
                finishReason = part.finishReason;
                break;
              case "error":
                console.error("Stream error:", part.error);
                if (streamer) {
                  await streamer.fail(String(part.error));
                }
                throw new Error(`Stream error: ${part.error}`);
              case "start-step":
              case "finish-step":
                break;

              default:
                // Ignore other part types
                break;
            }
          }

          // Finish the delta stream
          if (streamer) {
            await streamer.finish();
          }

          // Save the assistant message if we have content
          if (assistantContent.length > 0) {
            await ctx.runMutation(component.messages.add, {
              threadId: args.threadId,
              message: {
                role: "assistant",
                content: assistantContent,
              },
            });
          }

          // Handle tool calls
          if (toolCalls.length > 0) {
            // Set status to awaiting_tool_results
            await ctx.runMutation(component.threads.setStatus, {
              threadId: args.threadId,
              status: "awaiting_tool_results",
            });

            // Create tool call records and schedule execution
            for (const tc of toolCalls) {
              const toolDef = toolDefinitions.find((t) => t.name === tc.toolName);
              if (!toolDef) {
                throw new Error(`Tool definition not found for ${tc.toolName}`);
              }

              if (toolDef.type === "sync") {
                // Sync tool - schedule execution that returns the result
                await ctx.runMutation(component.agent.scheduleToolCall, {
                  threadId: args.threadId,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  args: tc.args,
                  handler: toolDef.handler,
                });
              } else {
                // Async tool - schedule callback that does NOT return the result
                await ctx.runMutation(component.agent.scheduleAsyncToolCall, {
                  threadId: args.threadId,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  args: tc.args,
                  callback: toolDef.callback,
                });
              }
            }
          } else if (finishReason === "stop" || finishReason === "end-turn") {
            // No tool calls and finished - mark as completed
            await ctx.runMutation(component.threads.setStatus, {
              threadId: args.threadId,
              status: "completed",
            });
          }
        } catch (error) {
          console.error("Error in continueStream:", error);
          if (streamer) {
            await streamer.fail(error instanceof Error ? error.message : "Unknown error");
          }
          await ctx.runMutation(component.threads.setStatus, {
            threadId: args.threadId,
            status: "failed",
          });
          throw error;
        }

        return null;
      } finally {
        await ctx.runMutation(component.threads.clearStreamId, {
          threadId: args.threadId,
        });
      }
    },
  });
}

// ============================================================================
// Agent API Definition
// ============================================================================

async function checkThreadIsIdle(component: ComponentApi, ctx: MutationCtx, threadId: Id<"threads">) {
  const thread = await ctx.runQuery(component.threads.get, { threadId });
  if (!thread) {
    throw new Error(`Thread ${threadId} not found`);
  }
  switch (thread.status) {
    case "awaiting_tool_results":
    case "streaming":
      throw new Error(`Thread ${threadId} status=${thread.status}, cannot resume`);
  }
}

export type StreamArgs =
  | { kind: "list"; startOrder?: number }
  | { kind: "deltas"; cursors: Array<{ streamId: string; cursor: number }> };

export type StreamMessage = {
  streamId: string;
  status: "streaming" | "finished" | "aborted";
  format?: "UIMessageChunk" | "TextStreamPart";
  order: number;
  threadId: string;
};

export type StreamDelta = {
  streamId: string;
  start: number;
  end: number;
  parts: Array<unknown>;
};

export type MessagesWithStreamsResult = {
  messages: MessageDoc[];
  streams?: { kind: "list"; messages: StreamMessage[] } | { kind: "deltas"; deltas: StreamDelta[] };
};

export type AgentApi<V extends FunctionVisibility = "public"> = {
  createThread: RegisteredAction<V, { prompt?: string }, string>;
  sendMessage: RegisteredMutation<V, { threadId: string; prompt: string }, null>;
  resumeThread: RegisteredMutation<V, { threadId: string; prompt?: string }, null>;
  stopThread: RegisteredMutation<V, { threadId: string }, null>;
  getThread: RegisteredQuery<V, { threadId: string }, ThreadDoc | null>;
  listMessages: RegisteredQuery<V, { threadId: string }, MessageDoc[]>;
  listMessagesWithStreams: RegisteredQuery<V, { threadId: string; streamArgs?: StreamArgs }, MessagesWithStreamsResult>;
  listThreads: RegisteredQuery<V, { limit?: number }, ThreadDoc[]>;
  deleteThread: RegisteredMutation<V, { threadId: string }, null>;
  addToolResult: RegisteredMutation<V, { toolCallId: string; result: unknown }, null>;
  addToolError: RegisteredMutation<V, { toolCallId: string; error: string }, null>;
};

export type AgentApiOptions = {
  /** Optional authorization callback for thread access control */
  authorizationCallback?: (ctx: QueryCtx | MutationCtx | ActionCtx, threadId: string) => Promise<void> | void;
  /** Optional: Function to enqueue actions via workpool (used for both stream handler and tools unless overridden) */
  workpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
  /** Optional: Override workpool for tool execution only */
  toolExecutionWorkpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
};

async function serializeWorkpoolOptions(options?: AgentApiOptions): Promise<{
  workpoolEnqueueAction?: string;
  toolExecutionWorkpoolEnqueueAction?: string;
}> {
  const result: {
    workpoolEnqueueAction?: string;
    toolExecutionWorkpoolEnqueueAction?: string;
  } = {};
  if (options?.workpoolEnqueueAction) {
    const handle = await createFunctionHandle(options.workpoolEnqueueAction);
    result.workpoolEnqueueAction = handle.toString();
  }
  if (options?.toolExecutionWorkpoolEnqueueAction) {
    const handle = await createFunctionHandle(options.toolExecutionWorkpoolEnqueueAction);
    result.toolExecutionWorkpoolEnqueueAction = handle.toString();
  }
  return result;
}

function createAgentApi(
  component: ComponentApi,
  ref: FunctionReference<"action", "internal" | "public", { threadId: string }>,
  action: typeof actionGeneric | typeof internalActionGeneric,
  query: typeof queryGeneric | typeof internalQueryGeneric,
  mutation: typeof mutationGeneric | typeof internalMutationGeneric,
  options?: AgentApiOptions,
) {
  const authorize = options?.authorizationCallback;

  return {
    createThread: action({
      args: {
        prompt: v.optional(v.string()),
      },
      returns: v.string(),
      handler: async (ctx, args) => {
        // Create a function handle that can be scheduled from within the component
        const handle = await createFunctionHandle(ref);

        // Serialize workpool options
        const serializedWorkpool = await serializeWorkpoolOptions(options);

        const thread = await ctx.runMutation(component.threads.create, {
          streamFnHandle: handle,
          ...serializedWorkpool,
        });

        if (args.prompt) {
          await ctx.runMutation(component.messages.add, {
            threadId: thread._id as Id<"threads">,
            message: {
              role: "user",
              content: args.prompt,
            },
          });

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
        await checkThreadIsIdle(component, ctx, args.threadId as Id<"threads">);
        await ctx.runMutation(component.messages.add, {
          threadId: args.threadId,
          message: {
            role: "user",
            content: args.prompt,
          },
        });
        await ctx.runMutation(component.threads.resume, {
          threadId: args.threadId,
        });
        await ctx.scheduler.runAfter(0, component.agent.continueStream, {
          threadId: args.threadId,
        });
        return null;
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
        await checkThreadIsIdle(component, ctx, threadId);

        if (args.prompt) {
          await ctx.runMutation(component.messages.add, {
            threadId,
            message: {
              role: "user",
              content: args.prompt,
            },
          });
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
        await ctx.runMutation(component.threads.setStopSignal, {
          threadId: args.threadId as Id<"threads">,
          stopSignal: true,
        });
        return null;
      },
    }),
    getThread: query({
      args: {
        threadId: v.string(),
      },
      returns: v.union(vClientThreadDoc, v.null()),
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
        return ctx.runQuery(component.messages.list, {
          threadId: args.threadId as Id<"threads">,
        });
      },
    }),
    listMessagesWithStreams: query({
      args: {
        threadId: v.string(),
        streamArgs: v.optional(
          v.union(
            v.object({
              kind: v.literal("list"),
              startOrder: v.optional(v.number()),
            }),
            v.object({
              kind: v.literal("deltas"),
              cursors: v.array(v.object({ streamId: v.string(), cursor: v.number() })),
            }),
          ),
        ),
      },
      handler: async (
        ctx,
        args,
      ): Promise<{
        messages: MessageDoc[];
        streams?:
          | {
              kind: "list";
              messages: Array<{
                streamId: string;
                status: "streaming" | "finished" | "aborted";
                format?: "UIMessageChunk" | "TextStreamPart";
                order: number;
                threadId: string;
              }>;
            }
          | {
              kind: "deltas";
              deltas: Array<{
                streamId: string;
                start: number;
                end: number;
                parts: Array<unknown>;
              }>;
            };
      }> => {
        if (authorize) await authorize(ctx, args.threadId);
        const messages = await ctx.runQuery(component.messages.list, {
          threadId: args.threadId,
        });

        if (!args.streamArgs) {
          return { messages };
        }

        if (args.streamArgs.kind === "list") {
          const streamMessages = await ctx.runQuery(component.streams.list, {
            threadId: args.threadId,
            startOrder: args.streamArgs.startOrder,
            statuses: ["streaming", "finished"],
          });
          return {
            messages,
            streams: {
              kind: "list",
              messages: streamMessages,
            },
          };
        }

        // kind === "deltas"
        const deltas = await ctx.runQuery(component.streams.listDeltas, {
          threadId: args.threadId,
          cursors: args.streamArgs.cursors.map((c) => ({
            streamId: c.streamId as Id<"streaming_messages">,
            cursor: c.cursor,
          })),
        });
        return {
          messages,
          streams: {
            kind: "deltas",
            deltas,
          },
        };
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
        toolCallId: v.string(),
        result: v.any(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        await ctx.runMutation(component.agent.addToolResult, {
          toolCallId: args.toolCallId,
          result: args.result,
        });
        return null;
      },
    }),
    addToolError: mutation({
      args: {
        toolCallId: v.string(),
        error: v.string(),
      },
      returns: v.null(),
      handler: async (ctx, args) => {
        await ctx.runMutation(component.agent.addToolError, {
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

// ============================================================================
// Workpool Bridge Helper
// ============================================================================

/**
 * Type for a Workpool instance that has an enqueueAction method.
 * This is compatible with @convex-dev/workpool's Workpool class.
 */

type WorkpoolLike = {
  enqueueAction: (
    ctx: GenericMutationCtx<GenericDataModel>,
    fn: FunctionReference<"action", FunctionVisibility, any, any>,
    fnArgs: any,
    options?: any,
  ) => Promise<any>;
};

/**
 * Creates a workpool bridge mutation that can be used with defineAgentApi.
 *
 * This helper creates an internal mutation that forwards action execution to your workpool,
 * allowing the agent to use workpool's parallelism controls and retry mechanisms.
 *
 * @example
 * ```typescript
 * // convex/workpool.ts
 * import { Workpool } from "@convex-dev/workpool";
 * import { components } from "./_generated/api";
 * import { createWorkpoolBridge } from "convex-durable-agents";
 *
 * const pool = new Workpool(components.workpool, { maxParallelism: 5 });
 * export const { enqueueWorkpoolAction } = createWorkpoolBridge(pool);
 *
 * // convex/chat.ts
 * export const { createThread, sendMessage, ... } = defineAgentApi(
 *   components.durable_agent,
 *   internal.chat.chatAgentHandler,
 *   { workpoolEnqueueAction: internal.workpool.enqueueWorkpoolAction }
 * );
 * ```
 */
export function createWorkpoolBridge(workpool: WorkpoolLike) {
  return {
    enqueueWorkpoolAction: internalMutationGeneric({
      args: {
        action: v.string(),
        args: v.any(),
      },
      returns: v.null(),
      handler: async (ctx, { action, args }) => {
        await workpool.enqueueAction(
          ctx,
          action as unknown as FunctionReference<"action", "internal", Record<string, unknown>, unknown>,
          args as Record<string, unknown>,
        );
        return null;
      },
    }),
  };
}
