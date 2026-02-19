/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    agent: {
      continueStream: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null,
        Name
      >;
      tryContinueAllThreads: FunctionReference<
        "action",
        "internal",
        {},
        null,
        Name
      >;
    };
    messages: {
      add: FunctionReference<
        "mutation",
        "internal",
        {
          committedSeq?: number;
          msg: {
            id?: string;
            metadata?: any;
            parts: Array<any>;
            role: "system" | "user" | "assistant";
          };
          overwrite?: boolean;
          streaming?: boolean;
          threadId: string;
        },
        string,
        Name
      >;
      applyToolOutcomes: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          committedSeq?: number;
          id: string;
          metadata?: any;
          parts: Array<any>;
          role: "system" | "user" | "assistant";
          threadId: string;
        }>,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { excludeSystemMessages?: boolean; threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          committedSeq?: number;
          id: string;
          metadata?: any;
          parts: Array<any>;
          role: "system" | "user" | "assistant";
          threadId: string;
        }>,
        Name
      >;
    };
    streams: {
      abort: FunctionReference<
        "mutation",
        "internal",
        { reason: string; streamId: string },
        boolean,
        Name
      >;
      addDelta: FunctionReference<
        "mutation",
        "internal",
        {
          lockId: string;
          msgId: string;
          parts: Array<any>;
          seq: number;
          streamId: string;
        },
        boolean,
        Name
      >;
      cancelInactiveStreams: FunctionReference<
        "mutation",
        "internal",
        { activeStreamId: string; threadId: string },
        null,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        string,
        Name
      >;
      deleteStreamAsync: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string; streamId: string },
        null,
        Name
      >;
      finish: FunctionReference<
        "mutation",
        "internal",
        { streamId: string },
        null,
        Name
      >;
      heartbeat: FunctionReference<
        "mutation",
        "internal",
        { lockId: string; streamId: string },
        boolean,
        Name
      >;
      queryStreamingMessageUpdates: FunctionReference<
        "query",
        "internal",
        { fromSeq?: number; threadId: string },
        { messages: Array<{ msgId: string; parts: Array<any> }> },
        Name
      >;
      take: FunctionReference<
        "mutation",
        "internal",
        { lockId: string; streamId: string; threadId: string },
        any,
        Name
      >;
    };
    threads: {
      clearRetryState: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null,
        Name
      >;
      clearStreamId: FunctionReference<
        "mutation",
        "internal",
        { streamId?: string; threadId: string },
        boolean,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          onStatusChangeHandle?: string;
          streamFnHandle: string;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        },
        {
          _creationTime: number;
          _id: string;
          retryState?: {
            attempt: number;
            error: string;
            kind?: string;
            maxAttempts: number;
            nextRetryAt: number;
            requiresExplicitHandling: boolean;
            retryFnId?: string;
            retryable: boolean;
            scope: "stream";
          };
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          stopSignal: boolean;
          streamFnHandle: string;
          streamId?: string | null;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        },
        Name
      >;
      finalizeStreamTurn: FunctionReference<
        "mutation",
        "internal",
        {
          expectedSeq?: number;
          status?:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          streamId: string;
          threadId: string;
        },
        boolean,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        {
          _creationTime: number;
          _id: string;
          retryState?: {
            attempt: number;
            error: string;
            kind?: string;
            maxAttempts: number;
            nextRetryAt: number;
            requiresExplicitHandling: boolean;
            retryFnId?: string;
            retryable: boolean;
            scope: "stream";
          };
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          stopSignal: boolean;
          streamFnHandle: string;
          streamId?: string | null;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        Array<{
          _creationTime: number;
          _id: string;
          retryState?: {
            attempt: number;
            error: string;
            kind?: string;
            maxAttempts: number;
            nextRetryAt: number;
            requiresExplicitHandling: boolean;
            retryFnId?: string;
            retryable: boolean;
            scope: "stream";
          };
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          stopSignal: boolean;
          streamFnHandle: string;
          streamId?: string | null;
          toolExecutionWorkpoolEnqueueAction?: string;
          workpoolEnqueueAction?: string;
        }>,
        Name
      >;
      listIncomplete: FunctionReference<
        "query",
        "internal",
        {},
        Array<string>,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null,
        Name
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null,
        Name
      >;
      scheduleRetry: FunctionReference<
        "mutation",
        "internal",
        {
          attempt: number;
          error: string;
          kind?: string;
          maxAttempts: number;
          nextRetryAt: number;
          requiresExplicitHandling: boolean;
          retryable: boolean;
          scope: "stream";
          threadId: string;
        },
        null,
        Name
      >;
      setStatus: FunctionReference<
        "mutation",
        "internal",
        {
          status:
            | "streaming"
            | "awaiting_tool_results"
            | "completed"
            | "failed"
            | "stopped";
          streamId?: string;
          threadId: string;
        },
        null,
        Name
      >;
      setStopSignal: FunctionReference<
        "mutation",
        "internal",
        { stopSignal: boolean; threadId: string },
        null,
        Name
      >;
    };
    tool_calls: {
      addToolError: FunctionReference<
        "mutation",
        "internal",
        { error: string; threadId: string; toolCallId: string },
        null,
        Name
      >;
      addToolResult: FunctionReference<
        "mutation",
        "internal",
        { result: any; threadId: string; toolCallId: string },
        null,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          callback?: string;
          handler?: string;
          msgId: string;
          retry?: any;
          saveDelta: boolean;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        {
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        Name
      >;
      getByToolCallId: FunctionReference<
        "query",
        "internal",
        { threadId: string; toolCallId: string },
        {
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        }>,
        Name
      >;
      listPending: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          args: any;
          callbackAttempt?: number;
          callbackLastError?: string;
          error?: string;
          executionAttempt?: number;
          executionLastError?: string;
          executionMaxAttempts?: number;
          executionRetryPolicy?: any;
          handler?: string;
          msgId: string;
          nextRetryAt?: number;
          result?: any;
          status: "pending" | "completed" | "failed";
          threadId: string;
          toolCallId: string;
          toolName: string;
        }>,
        Name
      >;
      resumePendingSyncToolExecutions: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        number,
        Name
      >;
      scheduleAsyncToolCall: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          callback: string;
          msgId: string;
          saveDelta: boolean;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        null,
        Name
      >;
      scheduleToolCall: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          handler: string;
          msgId: string;
          retry?: any;
          saveDelta: boolean;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        null,
        Name
      >;
      setError: FunctionReference<
        "mutation",
        "internal",
        { error: string; id: string },
        boolean,
        Name
      >;
      setResult: FunctionReference<
        "mutation",
        "internal",
        { id: string; result: any },
        boolean,
        Name
      >;
      setToolCallTimeout: FunctionReference<
        "mutation",
        "internal",
        { threadId: string; timeout: number | null; toolCallId: string },
        null,
        Name
      >;
    };
  };
