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
      addToolError: FunctionReference<
        "mutation",
        "internal",
        { error: string; toolCallId: string },
        null,
        Name
      >;
      addToolResult: FunctionReference<
        "mutation",
        "internal",
        { result: any; toolCallId: string },
        null,
        Name
      >;
      continueStream: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null,
        Name
      >;
      scheduleAsyncToolCall: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          callback: string;
          msgId: string;
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
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
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
          preserveToolOutputs?: boolean;
          threadId: string;
        },
        string,
        Name
      >;
      appendPart: FunctionReference<
        "mutation",
        "internal",
        { msgId: string; part: any; threadId: string },
        null,
        Name
      >;
      appendToolOutcomePart: FunctionReference<
        "mutation",
        "internal",
        {
          msgId: string;
          part: any;
          threadId: string;
          throwOnMissingToolCallPart?: boolean;
          toolCallId: string;
        },
        null,
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
      isAlive: FunctionReference<
        "query",
        "internal",
        { streamId: string },
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
      clearStreamId: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
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
      get: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        {
          _creationTime: number;
          _id: string;
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
      create: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          msgId: string;
          threadId: string;
          toolCallId: string;
          toolName: string;
        },
        {
          _creationTime: number;
          _id: string;
          args: any;
          error?: string;
          msgId: string;
          result?: any;
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
          error?: string;
          msgId: string;
          result?: any;
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
          error?: string;
          msgId: string;
          result?: any;
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
          error?: string;
          msgId: string;
          result?: any;
          threadId: string;
          toolCallId: string;
          toolName: string;
        }>,
        Name
      >;
      setError: FunctionReference<
        "mutation",
        "internal",
        { error: string; id: string },
        null,
        Name
      >;
      setResult: FunctionReference<
        "mutation",
        "internal",
        { id: string; result: any },
        null,
        Name
      >;
    };
  };
