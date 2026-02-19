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
import { Logger } from "../utils/logger.js";
import {
  clampDelayMs,
  classifyRetryErrorDefault,
  computeBackoffDelayMs,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  extractRetryAfterDelayMs,
  normalizeErrorMessage,
  type RetryDecision,
  type RetryErrorKind,
  type RetryOptions,
} from "../utils/retry.js";
import { STREAM_HEARTBEAT_INTERVAL_MS } from "../utils/streaming.js";
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

export type {
  RetryContext,
  RetryDecision,
  RetryErrorClassification,
  RetryErrorKind,
  RetryErrorSignal,
  RetryOptions,
} from "../utils/retry.js";

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
  kind?: RetryErrorKind | "tool_execution";
  retryable?: boolean;
  attempt?: number;
  maxAttempts?: number;
  requiresExplicitHandling?: boolean;
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
  /** Optional: Configure automatic retry handling for stream failures */
  retry?: false | RetryOptions;
  /** Optional: Callback invoked when a retry is scheduled */
  onRetry?: (
    ctx: ActionCtx,
    args: {
      scope: "stream";
      threadId: string;
      streamId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      kind?: RetryErrorKind;
      error: string;
    },
  ) => void | Promise<void>;
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
    tc: {
      toolCallId: string;
      toolName: string;
      args: unknown;
      msgId: string | undefined;
      threadId: string;
      saveDelta: boolean;
    },
    toolDefinitions: Array<ToolDefinition>,
    logger: Logger,
  ) {
    if (!tc.msgId) {
      throw new Error("Unable to schedule tool call without preceding message ID");
    }
    const toolDef = toolDefinitions.find((t) => t.name === tc.toolName);
    if (!toolDef) {
      throw new Error(`Tool definition not found for ${tc.toolName}`);
    }
    logger.debug(`Scheduling ${toolDef.type} tool call: ${tc.toolName} (callId=${tc.toolCallId}, msgId=${tc.msgId})`);
    if (toolDef.type === "sync") {
      // Sync tool - schedule execution that returns the result
      await ctx.runMutation(component.tool_calls.scheduleToolCall, {
        threadId: tc.threadId,
        msgId: tc.msgId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        handler: toolDef.handler,
        saveDelta: tc.saveDelta,
        retry: toolDef.retry,
      });
    } else {
      // Async tool - schedule callback that does NOT return the result
      await ctx.runMutation(component.tool_calls.scheduleAsyncToolCall, {
        threadId: tc.threadId,
        msgId: tc.msgId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        callback: toolDef.callback,
        saveDelta: tc.saveDelta,
      });
    }
    logger.debug(`Tool call scheduled: ${tc.toolName} (callId=${tc.toolCallId})`);
  }

  return internalActionGeneric({
    args: {
      threadId: v.string(),
      streamId: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      const logger = new Logger(`handler:${args.streamId}`);
      logger.debug(`Starting stream handler for thread=${args.threadId}, stream=${args.streamId}`);

      const resolvedArgs =
        typeof argsOrFactory === "function" ? await argsOrFactory(ctx as ActionCtx, args.threadId) : argsOrFactory;
      const {
        tools,
        saveStreamDeltas,
        transformMessages = (messages) => messages,
        onMessageComplete: usageHandlerCallback,
        onTurnComplete: turnCompleteHandlerCallback,
        onError: errorHandlerCallback,
        retry,
        onRetry: onRetryCallback,
        ...streamTextArgs
      } = resolvedArgs;

      const lockId = crypto.randomUUID();
      logger.debug(`Lock ID generated: ${lockId}, saveStreamDeltas=${!!saveStreamDeltas}`);
      const streamingOptions = typeof saveStreamDeltas === "object" ? saveStreamDeltas : DEFAULT_STREAMING_OPTIONS;
      const streamer = new Streamer(component, ctx as ActionCtx, {
        throttleMs: streamingOptions.throttleMs ?? DEFAULT_STREAMING_OPTIONS.throttleMs!,
        heartbeatMs: STREAM_HEARTBEAT_INTERVAL_MS,
        threadId: args.threadId as Id<"threads">,
        streamId: args.streamId as Id<"streams">,
        lockId,
      });
      logger.debug("Acquiring stream lock...");
      const stream = await streamer.acquireLock().catch((e) => {
        logger.warn(`Skipping stream handler, we did not successfully get a lock on the stream: ${e.message}`);
        return null;
      });
      if (stream == null) {
        logger.debug("Stream lock acquisition failed, exiting handler");
        return null;
      }
      logger.debug(`Stream lock acquired (seq=${stream.seq})`);
      streamer.startHeartbeat();
      let finalStatus: "awaiting_tool_results" | "completed" | "failed" | undefined;
      let classifiedErrorKind: RetryErrorKind | "tool_execution" | undefined;
      let classifiedRetryable: boolean | undefined;
      let classifiedRequiresExplicitHandling: boolean | undefined;
      let classifiedAttempt: number | undefined;
      let classifiedMaxAttempts: number | undefined;
      const retryEnabled = retry !== false && (retry?.enabled ?? true);
      const maxRetryAttempts = retryEnabled ? Math.max(1, retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS) : 1;
      try {
        // Set up delta streamer if enabled
        if (saveStreamDeltas) {
          logger.debug("Enabling delta streaming");
          streamer.enableDeltaStreaming();
        }

        logger.debug("Building tool definitions...");
        const toolDefinitions = await buildToolDefinitions(tools);
        logger.debug(
          `Built ${toolDefinitions.length} tool definitions: [${toolDefinitions.map((t) => t.name).join(", ")}]`,
        );

        // Build tool definitions for AI SDK (without execute functions)
        const handlerlessTools: Record<string, Tool> = {};
        for (const toolDef of toolDefinitions) {
          handlerlessTools[toolDef.name] = tool({
            description: toolDef.description,
            inputSchema: jsonSchema(toolDef.parameters as Parameters<typeof jsonSchema>[0]),
            // No execute function - we handle tool calls manually
          });
        }

        const thread = await ctx.runQuery(component.threads.get, {
          threadId: args.threadId as Id<"threads">,
        });
        if (!thread) {
          throw new Error(`Thread ${args.threadId} not found`);
        }

        const retryState = thread.retryState?.scope === "stream" ? thread.retryState : undefined;
        const retryAttempt = retryState ? retryState.attempt + 1 : 1;
        logger.debug(`Stream attempt ${retryAttempt}/${maxRetryAttempts}`);
        logger.debug("Applying tool outcomes and fetching messages...");
        const messages: MessageDoc[] = await ctx.runMutation(component.messages.applyToolOutcomes, {
          threadId: args.threadId,
        });
        logger.debug(`Fetched ${messages.length} messages from thread`);

        const uiMessages = messages.map((m) => messageDocToUIMessage(m));
        logger.debug(`Converted ${uiMessages.length} UI messages, transforming to model messages...`);
        const modelMessages = transformMessages(await convertToModelMessages(uiMessages, { tools: handlerlessTools }));
        logger.debug(`Model messages ready (${modelMessages.length} messages), starting streamText...`);

        let toolCallCount = 0;
        let streamPartCount = 0;
        try {
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
            originalMessages: uiMessages,
            onFinish: ({ responseMessage: finalResponseMessage }) => {
              responseMessage = finalResponseMessage;
            },
          });

          let msgId: string | undefined;
          if (messages.length > 0) {
            msgId = messages[messages.length - 1]!.id;
            logger.debug(`Setting initial message ID from last message: ${msgId}`);
            await streamer.setMessageId(msgId, true);
          }
          logger.debug("Processing UI message stream parts...");
          for await (const part of uiMessageStream) {
            // Track whether meaningful stream output was emitted; start/finish/error
            // control parts alone should not block a retry.
            if (part.type !== "start" && part.type !== "finish" && part.type !== "error") {
              streamPartCount++;
            }
            if (part.type === "start") {
              msgId = part.messageId;
              logger.debug(`Stream part: start (messageId=${msgId})`);
              await streamer.setMessageId(
                msgId,
                messages?.some((m) => m.id === msgId),
              );
            }
            await streamer.process(part);

            switch (part.type) {
              case "tool-input-available":
                toolCallCount++;
                logger.debug(
                  `Stream part: tool-input-available (tool=${part.toolName}, callId=${part.toolCallId}, count=${toolCallCount})`,
                );
                await scheduleToolCall(
                  ctx,
                  {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    args: part.input,
                    msgId: msgId,
                    threadId: args.threadId,
                    saveDelta: !!saveStreamDeltas,
                  },
                  toolDefinitions,
                  logger,
                );
                break;
              case "finish":
                finishReason = part.finishReason;
                logger.debug(`Stream part: finish (reason=${finishReason})`);
                break;
              case "error":
                logger.error("Stream error:", part.errorText);
                throw new Error(`Stream error: ${part.errorText}`);
              default:
                break;
            }
          }
          logger.debug(`Stream iteration complete (toolCallCount=${toolCallCount}, finishReason=${finishReason})`);

          if (!responseMessage) {
            throw new Error("No response message");
          }
          logger.debug(
            `Response message received (role=${responseMessage.role}, parts=${responseMessage.parts.length})`,
          );

          const providerMetadata = await getStreamTextProviderMetadata(result);
          const usage = await getStreamTextUsage(result, providerMetadata);
          logger.debug(`Usage info: ${usage ? JSON.stringify(usage) : "none"}`);
          if (usage && usageHandlerCallback) {
            logger.debug("Invoking onMessageComplete callback...");
            try {
              await usageHandlerCallback(ctx as ActionCtx, {
                threadId: args.threadId,
                streamId: args.streamId,
                message: responseMessage,
                usage,
                providerMetadata: serializeForConvex(providerMetadata),
              });
              logger.debug("onMessageComplete callback succeeded");
            } catch (e) {
              console.error("endOfTurnCallback callback failed:", e);
            }
          }

          if (responseMessage.role === "assistant" && responseMessage.parts.length > 0) {
            logger.debug(
              `Saving assistant response (id=${responseMessage.id}, parts=${responseMessage.parts.length}, seq=${stream.seq})`,
            );
            await ctx.runMutation(component.messages.add, {
              threadId: args.threadId,
              streaming: true,
              msg: responseMessage,
              overwrite: true,
              committedSeq: stream.seq,
            });
            logger.debug("Applying tool outcomes after saving response...");
            await ctx.runMutation(component.messages.applyToolOutcomes, {
              threadId: args.threadId,
            });
          }

          if (toolCallCount > 0) {
            logger.debug(`Setting thread status to awaiting_tool_results (${toolCallCount} tool calls)`);
            finalStatus = "awaiting_tool_results";
          } else if (finishReason && finishReason !== "tool-calls") {
            logger.debug(`No tool calls, setting thread status to completed (finishReason=${finishReason})`);
            finalStatus = "completed";
            if (turnCompleteHandlerCallback) {
              logger.debug("Invoking onTurnComplete callback...");
              try {
                await turnCompleteHandlerCallback(ctx as ActionCtx, {
                  threadId: args.threadId,
                  streamId: args.streamId,
                  providerMetadata: serializeForConvex(providerMetadata),
                  finishReason,
                });
                logger.debug("onTurnComplete callback succeeded");
              } catch (e) {
                console.error("turnCompleteHandler callback failed:", e);
              }
            }
          } else {
            logger.debug(`Unhandled end state: toolCallCount=${toolCallCount}, finishReason=${finishReason}`);
          }

          logger.debug("Finishing delta stream...");
          await streamer.finish();
          await ctx.runMutation(component.threads.clearRetryState, {
            threadId: args.threadId as Id<"threads">,
          });
          logger.debug("Stream handler completed successfully");
          return null;
        } catch (attemptError) {
          const normalizedError = normalizeErrorMessage(attemptError);
          const defaultClassification = classifyRetryErrorDefault(attemptError);
          let decision: RetryDecision = defaultClassification.retryable
            ? { action: "retry" }
            : {
                action: "fail",
                kind: defaultClassification.kind,
                requiresExplicitHandling: defaultClassification.requiresExplicitHandling,
              };
          if (retryEnabled && retry?.classify) {
            try {
              decision = await retry.classify(ctx as ActionCtx, {
                threadId: args.threadId,
                streamId: args.streamId,
                attempt: retryAttempt,
                maxAttempts: maxRetryAttempts,
                toolCallsScheduled: toolCallCount,
                streamPartCount,
                error: attemptError,
                normalizedError,
                defaultClassification,
                defaultDecision: decision,
              });
            } catch (classifierError) {
              logger.warn(
                `retry.classify failed; falling back to default classification: ${normalizeErrorMessage(classifierError)}`,
              );
            }
          }

          const retryAfterToolCalls = retry !== false && (retry?.retryAfterToolCalls ?? false);
          const retryBlockedByToolCalls = toolCallCount > 0 && !retryAfterToolCalls;
          const canRetry =
            retryEnabled &&
            decision.action === "retry" &&
            retryAttempt < maxRetryAttempts &&
            !retryBlockedByToolCalls &&
            streamPartCount === 0;

          if (canRetry) {
            const retryAfterDelayMs = extractRetryAfterDelayMs(defaultClassification.signal);
            const delayMs = clampDelayMs(
              (decision.action === "retry" ? decision.delayMs : undefined) ??
                retryAfterDelayMs ??
                computeBackoffDelayMs(retryAttempt, retry?.backoff),
            );
            classifiedErrorKind = defaultClassification.kind;
            classifiedRetryable = true;
            classifiedRequiresExplicitHandling = false;
            classifiedAttempt = retryAttempt;
            classifiedMaxAttempts = maxRetryAttempts;
            logger.warn(
              `Scheduling retry after recoverable error (attempt ${retryAttempt}/${maxRetryAttempts}, delay=${delayMs}ms): ${normalizedError}`,
            );
            if (onRetryCallback) {
              try {
                await onRetryCallback(ctx as ActionCtx, {
                  scope: "stream",
                  threadId: args.threadId,
                  streamId: args.streamId,
                  attempt: retryAttempt,
                  maxAttempts: maxRetryAttempts,
                  delayMs,
                  kind: defaultClassification.kind,
                  error: normalizedError,
                });
              } catch (onRetryError) {
                console.error("onRetry callback failed:", onRetryError);
              }
            }

            await ctx.runMutation(component.threads.scheduleRetry, {
              threadId: args.threadId as Id<"threads">,
              scope: "stream",
              attempt: retryAttempt,
              maxAttempts: maxRetryAttempts,
              nextRetryAt: Date.now() + delayMs,
              error: normalizedError,
              kind: defaultClassification.kind,
              retryable: true,
              requiresExplicitHandling: false,
            });
            await streamer.fail(normalizedError);
            logger.debug("Retry scheduled; ending current stream invocation");
            return null;
          }

          classifiedErrorKind =
            decision.action === "fail" ? (decision.kind ?? defaultClassification.kind) : defaultClassification.kind;
          classifiedRetryable = false;
          classifiedRequiresExplicitHandling =
            decision.action === "fail"
              ? (decision.requiresExplicitHandling ?? defaultClassification.requiresExplicitHandling)
              : defaultClassification.requiresExplicitHandling;
          classifiedAttempt = retryAttempt;
          classifiedMaxAttempts = maxRetryAttempts;
          throw attemptError;
        }
      } catch (error) {
        const normalizedError = normalizeErrorMessage(error);
        logger.error("Error in stream handler:", normalizedError);
        await ctx.runMutation(component.threads.clearRetryState, {
          threadId: args.threadId as Id<"threads">,
        });
        try {
          await streamer.fail(normalizedError);
        } catch (streamAbortError) {
          logger.error(
            `Failed to abort stream after handler error: ${streamAbortError instanceof Error ? streamAbortError.message : String(streamAbortError)}`,
          );
        }
        finalStatus = "failed";
        if (errorHandlerCallback) {
          logger.debug("Invoking onError callback...");
          try {
            await errorHandlerCallback(ctx as ActionCtx, {
              threadId: args.threadId,
              streamId: args.streamId,
              error: normalizedError,
              kind: classifiedErrorKind,
              retryable: classifiedRetryable,
              requiresExplicitHandling: classifiedRequiresExplicitHandling,
              attempt: classifiedAttempt,
              maxAttempts: classifiedMaxAttempts,
            });
          } catch (e) {
            console.error("errorHandler callback failed:", e);
          }
        }
        throw error;
      } finally {
        logger.debug("Finalizing stream turn and checking for continuation...");
        const finalizeArgs: {
          threadId: string;
          streamId: Id<"streams">;
          status?: "awaiting_tool_results" | "completed" | "failed";
          expectedSeq: number;
        } = {
          threadId: args.threadId,
          streamId: args.streamId as Id<"streams">,
          expectedSeq: stream.seq,
        };
        if (finalStatus) {
          finalizeArgs.status = finalStatus;
        }
        const shouldContinueThread = await ctx.runMutation(component.threads.finalizeStreamTurn, finalizeArgs);
        logger.debug(`Stream finalized, shouldContinueThread=${shouldContinueThread}`);
        if (shouldContinueThread) {
          logger.debug("Scheduling continueStream...");
          await ctx.scheduler.runAfter(0, component.agent.continueStream, {
            threadId: args.threadId,
          });
        }
      }
    },
  });
}
