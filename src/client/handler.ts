import {
  convertToModelMessages,
  generateId,
  jsonSchema,
  type ModelMessage,
  streamText,
  type Tool,
  tool,
  type UIMessage,
} from "ai";
import { type FunctionReference, type GenericActionCtx, internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";
import { serializeForConvex } from "./helpers.js";
import { Streamer } from "./streamer.js";
import { buildToolDefinitions, type ToolDefinition } from "./tools.js";
import { type ActionCtx, type DurableTool, type MessageDoc, messageDocToUIMessage } from "./types.js";
import { getStreamTextProviderMetadata, getStreamTextUsage, type UsageInfo } from "./usage.js";

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
// Stream Handler Action
// ============================================================================

export type MessageReceivedCallbackArgs = {
  threadId: string;
  streamId: string;
  message: UIMessage;
  usage: UsageInfo;
  providerMetadata?: unknown;
};

export type MessageReceivedCallback = (ctx: ActionCtx, args: MessageReceivedCallbackArgs) => void | Promise<void>;

export type TurnCompleteArgs = {
  threadId: string;
  streamId: string;
  providerMetadata?: unknown;
  finishReason?: string;
};

export type TurnCompleteCallback = (ctx: ActionCtx, args: TurnCompleteArgs) => void | Promise<void>;

export type ErrorHandlerArgs = {
  threadId: string;
  streamId: string;
  error: string;
};

export type ErrorHandlerCallback = (ctx: ActionCtx, args: ErrorHandlerArgs) => void | Promise<void>;

export type StreamHandlerArgs = Omit<Parameters<typeof streamText>[0], "tools" | "messages" | "prompt"> & {
  tools: Record<string, DurableTool<unknown, unknown>>;
  /** Optional: Save streaming deltas to the database for real-time client updates */
  saveStreamDeltas?: boolean | StreamingOptions;
  /** Optional: Transform the messages before sending them to the model */
  transformMessages?: (messages: ModelMessage[]) => ModelMessage[];
  /** Optional: Callback invoked once per stream handler invocation with token usage (best-effort) */
  onMessageComplete?: MessageReceivedCallback;
  /** Optional: Callback when the LLM response is complete (LLM signaled end or turn or stop condition is met) */
  onTurnComplete?: TurnCompleteCallback;
  /** Optional: Callback when an error occurs during the stream handler invocation */
  onError?: ErrorHandlerCallback;
  /** Optional: Function to enqueue actions via workpool (used for both stream handler and tools unless overridden) */
  workpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
  /** Optional: Override workpool for tool execution only */
  toolExecutionWorkpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
};

export type StreamHandlerArgsFactory = (
  ctx: ActionCtx,
  threadId: string,
) => StreamHandlerArgs | Promise<StreamHandlerArgs>;

export function streamHandlerAction(
  component: ComponentApi,
  argsOrFactory: StreamHandlerArgs | StreamHandlerArgsFactory,
) {
  async function scheduleToolCall(
    ctx: GenericActionCtx<any>,
    tc: { toolCallId: string; toolName: string; args: unknown; msgId: string | undefined; threadId: string },
    toolDefinitions: Array<ToolDefinition>,
  ) {
    if (!tc.msgId) {
      throw new Error("Unable to schedule tool call without preceding message ID");
    }
    const toolDef = toolDefinitions.find((t) => t.name === tc.toolName);
    if (!toolDef) {
      throw new Error(`Tool definition not found for ${tc.toolName}`);
    }
    if (toolDef.type === "sync") {
      // Sync tool - schedule execution that returns the result
      await ctx.runMutation(component.agent.scheduleToolCall, {
        threadId: tc.threadId,
        msgId: tc.msgId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        handler: toolDef.handler,
      });
    } else {
      // Async tool - schedule callback that does NOT return the result
      await ctx.runMutation(component.agent.scheduleAsyncToolCall, {
        threadId: tc.threadId,
        msgId: tc.msgId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        callback: toolDef.callback,
      });
    }
  }

  return internalActionGeneric({
    args: {
      threadId: v.string(),
      streamId: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      const resolvedArgs =
        typeof argsOrFactory === "function" ? await argsOrFactory(ctx as ActionCtx, args.threadId) : argsOrFactory;
      const {
        tools,
        saveStreamDeltas,
        transformMessages = (messages) => messages,
        onMessageComplete: usageHandlerCallback,
        onTurnComplete: turnCompleteHandlerCallback,
        onError: errorHandlerCallback,
        ...streamTextArgs
      } = resolvedArgs;

      const lockId = crypto.randomUUID();
      const streamingOptions = typeof saveStreamDeltas === "object" ? saveStreamDeltas : DEFAULT_STREAMING_OPTIONS;
      const streamer = new Streamer(component, ctx as ActionCtx, {
        throttleMs: streamingOptions.throttleMs ?? DEFAULT_STREAMING_OPTIONS.throttleMs!,
        threadId: args.threadId as Id<"threads">,
        streamId: args.streamId as Id<"streams">,
        lockId,
      });
      const stream = await streamer.start();

      const messages: MessageDoc[] = await ctx.runQuery(component.messages.list, {
        threadId: args.threadId,
      });

      // Set up delta streamer if enabled
      if (saveStreamDeltas) {
        streamer.enableDeltaStreaming();
      }

      try {
        const toolDefinitions = await buildToolDefinitions(tools);

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
          const modelMessages = transformMessages(
            await convertToModelMessages(
              messages.map((m) => messageDocToUIMessage(m)),
              { tools: handlerlessTools },
            ),
          );
          const result = streamText({
            ...streamTextArgs,
            prompt: undefined,
            messages: modelMessages,
            tools: handlerlessTools,
          });

          let finishReason: string | undefined;
          let responseMessage: UIMessage | undefined;

          const uiMessageStream = result.toUIMessageStream({
            generateMessageId: generateId,
            originalMessages: messages.map((m) => messageDocToUIMessage(m)),
            onFinish: ({ responseMessage: finalResponseMessage }) => {
              responseMessage = finalResponseMessage;
            },
          });

          let msgId: string | undefined;
          if (messages.length > 0) {
            msgId = messages[messages.length - 1]!.id;
            await streamer.setMessageId(msgId, true);
          }
          let toolCallCount = 0;
          const committedMessages: Set<string> = new Set();

          for await (const part of uiMessageStream) {
            if (part.type === "start") {
              msgId = part.messageId;
              await streamer.setMessageId(
                msgId,
                messages?.some((m) => m.id === msgId),
              );
              if (msgId && !committedMessages.has(msgId)) {
                try {
                await ctx.runMutation(component.messages.add, {
                  threadId: args.threadId,
                  msg: {
                    id: msgId,
                    role: "assistant" as const,
                    parts: [],
                  },
                  overwrite: false,
                });
              } catch(_) {
                // ignore error
              }
                committedMessages.add(msgId);
              }
            }
            await streamer.process(part);

            switch (part.type) {
              case "tool-input-available":
                toolCallCount++;
                await scheduleToolCall(
                  ctx,
                  {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    args: part.input,
                    msgId: msgId,
                    threadId: args.threadId,
                  },
                  toolDefinitions,
                );
                break;
              case "finish":
                finishReason = part.finishReason;
                break;
              case "error":
                console.error("Stream error:", part.errorText);
                throw new Error(`Stream error: ${part.errorText}`);
              default:
                // Ignore other part types
                break;
            }
          }

          // Finish the delta stream
          await streamer.finish();

          if (!responseMessage) {
            throw new Error("No response message");
          }

          const providerMetadata = await getStreamTextProviderMetadata(result);
          const usage = await getStreamTextUsage(result, providerMetadata);
          if (usage && usageHandlerCallback) {
            try {
              await usageHandlerCallback(ctx as ActionCtx, {
                threadId: args.threadId,
                streamId: args.streamId,
                message: responseMessage,
                usage,
                providerMetadata: serializeForConvex(providerMetadata),
              });
            } catch (e) {
              console.error("endOfTurnCallback callback failed:", e);
            }
          }

          // Save the assistant response if we have one
          if (responseMessage && responseMessage.role === "assistant" && responseMessage.parts.length > 0) {
            await ctx.runMutation(component.messages.add, {
              threadId: args.threadId,
              msg: responseMessage,
              overwrite: true,
              preserveToolOutputs: true,
              committedSeq: stream.seq,
            });
          }

          // Handle tool calls
          if (toolCallCount > 0) {
            // Set status to awaiting_tool_results
            await ctx.runMutation(component.threads.setStatus, {
              threadId: args.threadId,
              status: "awaiting_tool_results",
            });
          } else if (finishReason && finishReason !== "tool-calls") {
            // No tool calls and finished - mark as completed
            await ctx.runMutation(component.threads.setStatus, {
              threadId: args.threadId,
              status: "completed",
            });
            if (turnCompleteHandlerCallback) {
              try {
                await turnCompleteHandlerCallback(ctx as ActionCtx, {
                  threadId: args.threadId,
                  streamId: args.streamId,
                  providerMetadata: serializeForConvex(providerMetadata),
                  finishReason,
                });
              } catch (e) {
                console.error("turnCompleteHandler callback failed:", e);
              }
            }
          }
        } catch (error) {
          console.error("Error in stream handler:", error);
          if (streamer) {
            await streamer.fail(error instanceof Error ? error.message : "Unknown error");
          }
          await ctx.runMutation(component.threads.setStatus, {
            threadId: args.threadId,
            status: "failed",
          });
          if (errorHandlerCallback) {
            try {
              await errorHandlerCallback(ctx as ActionCtx, {
                threadId: args.threadId,
                streamId: args.streamId,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            } catch (e) {
              console.error("errorHandler callback failed:", e);
            }
          }
          throw error;
        }

        return null;
      } finally {
        const shouldContinueThread = await ctx.runMutation(component.threads.clearStreamId, {
          threadId: args.threadId,
        });
        if (shouldContinueThread) {
          await ctx.scheduler.runAfter(0, component.agent.continueStream, {
            threadId: args.threadId,
          });
        }
      }
    },
  });
}
