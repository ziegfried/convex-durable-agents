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
          message: {
            content: string | Array<any>;
            role: "system" | "user" | "assistant" | "tool";
          };
          threadId: string;
        },
        {
          _creationTime: number;
          _id: string;
          message: {
            content: string | Array<any>;
            role: "system" | "user" | "assistant" | "tool";
          };
          order: number;
          threadId: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        Array<{
          _creationTime: number;
          _id: string;
          message: {
            content: string | Array<any>;
            role: "system" | "user" | "assistant" | "tool";
          };
          order: number;
          threadId: string;
        }>,
        Name
      >;
    };
    streams: {
      abort: FunctionReference<
        "mutation",
        "internal",
        {
          finalDelta?: {
            end: number;
            parts: Array<any>;
            start: number;
            streamId: string;
          };
          reason: string;
          streamId: string;
        },
        boolean,
        Name
      >;
      abortByOrder: FunctionReference<
        "mutation",
        "internal",
        { order: number; reason: string; threadId: string },
        boolean,
        Name
      >;
      addDelta: FunctionReference<
        "mutation",
        "internal",
        { end: number; parts: Array<any>; start: number; streamId: string },
        boolean,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          format?: "UIMessageChunk" | "TextStreamPart";
          order: number;
          threadId: string;
        },
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
        {
          finalDelta?: {
            end: number;
            parts: Array<any>;
            start: number;
            streamId: string;
          };
          streamId: string;
        },
        null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          startOrder?: number;
          statuses?: Array<"streaming" | "finished" | "aborted">;
          threadId: string;
        },
        Array<{
          format?: "UIMessageChunk" | "TextStreamPart";
          order: number;
          status: "streaming" | "finished" | "aborted";
          streamId: string;
          threadId: string;
        }>,
        Name
      >;
      listDeltas: FunctionReference<
        "query",
        "internal",
        {
          cursors: Array<{ cursor: number; streamId: string }>;
          threadId: string;
        },
        Array<{
          end: number;
          parts: Array<any>;
          start: number;
          streamId: string;
        }>,
        Name
      >;
    };
    threads: {
      clearStreamId: FunctionReference<
        "mutation",
        "internal",
        { threadId: string },
        null,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        { streamFnHandle: string },
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
        { args: any; threadId: string; toolCallId: string; toolName: string },
        {
          _creationTime: number;
          _id: string;
          args: any;
          error?: string;
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
          result?: any;
          threadId: string;
          toolCallId: string;
          toolName: string;
        } | null,
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
