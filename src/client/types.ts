import type { UIMessage } from "ai";
import type {
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";

// ============================================================================
// Types
// ============================================================================

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery" | "auth">;
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation" | "auth">;
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

export type RetryState = {
  scope: "stream";
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number;
  error: string;
  kind?: string;
  retryable: boolean;
  requiresExplicitHandling: boolean;
};

export type ThreadDoc = {
  _id: string;
  _creationTime: number;
  status: ThreadStatus;
  stopSignal: boolean;
  streamId?: string | null;
  streamFnHandle: string;
  retryState?: RetryState;
};

const vThreadStatus = v.union(
  v.literal("streaming"),
  v.literal("awaiting_tool_results"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

export const _vClientThreadDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  status: vThreadStatus,
  stopSignal: v.boolean(),
  streamId: v.optional(v.union(v.string(), v.null())),
  streamFnHandle: v.string(),
  workpoolEnqueueAction: v.optional(v.string()),
  toolExecutionWorkpoolEnqueueAction: v.optional(v.string()),
  retryState: v.optional(
    v.object({
      scope: v.literal("stream"),
      attempt: v.number(),
      maxAttempts: v.number(),
      nextRetryAt: v.number(),
      error: v.string(),
      kind: v.optional(v.string()),
      retryable: v.boolean(),
      requiresExplicitHandling: v.boolean(),
      retryFnId: v.optional(v.string()),
    }),
  ),
});

export type MessageDoc = UIMessage<any> & {
  _id: string;
  _creationTime: number;
  threadId: string;
  committedSeq?: number | undefined;
};

export function messageDocToUIMessage(message: MessageDoc): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata,
  };
}

export type RetryBackoffConfig =
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

export type SyncToolRetryOptions = {
  /**
   * Opt-in to retry for this sync tool.
   */
  enabled: true;
  /**
   * Maximum execution attempts including the initial attempt.
   */
  maxAttempts?: number;
  /**
   * Retry backoff policy.
   */
  backoff?: RetryBackoffConfig;
  /**
   * Optional function to classify whether an error is retryable.
   * Receives { threadId, toolCallId, toolName, args, error, attempt, maxAttempts }.
   */
  shouldRetryError?: FunctionReference<"action", "internal" | "public">;
};

// Sync durable tool definition - handler returns the result directly
export type SyncTool<INPUT = unknown, OUTPUT = unknown> = {
  type: "sync";
  description: string;
  parameters: unknown; // JSON Schema
  handler: FunctionReference<"action", "internal" | "public">;
  retry?: SyncToolRetryOptions;
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
