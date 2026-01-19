# Durable Agents Component for Convex

[![npm version](https://badge.fury.io/js/convex-durable-agents.svg)](https://badge.fury.io/js/convex-durable-agents)

A Convex component for building durable AI agents with an async tool loop. The goal of this component is to provide a
way to build AI agents that can run indefinitely and survive failures and restarts. It provides some of the
functionality of the [Convex Agents Component](https://www.convex.dev/components/agent) (such as persistent streaming),
while deliberately leaving out some of the more advanced features (context management, RAG, rate limiting, etc.). The
component is built on top of the [AI SDK v6](https://ai-sdk.dev/) SDK and aims to expose its full `streamText` API with
persistence and durable execution.

**Note:** This component is still in early development and is not yet ready for production use. The API will very likely
change before a first stable release.

## Features

- **Async Execution**: Agent tool loop is executed asynchronously to avoid time limits of convex actions
- **Tool Execution**: via convex actions - support for both sync and async tools
- **Automatic Retries**: Failed tool calls are automatically retried
- **Workpool Support**: Optionally route agent and tool execution through `@convex-dev/workpool` for parallelism control
  and retry mechanisms

## Roadmap

- **Durable Execution**: Agent tool loops survive crashes and dev server restarts

## Installation

```bash
npm install convex-durable-agents ai zod
```

## Quick Start

### 1. Configure the Component

Create a `convex.config.ts` file in your app's `convex/` folder:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import durableAgents from "convex-durable-agents/convex.config.js";

const app = defineApp();
app.use(durableAgents);

export default app;
```

### 2. Define Your Agent

Create a chat handler with your AI model and tools:

```ts
// convex/chat.ts
import { z } from "zod";
import { components, internal } from "./_generated/api";
import { createActionTool, defineAgentApi, streamHandlerAction } from "convex-durable-agents";
import { openai } from "@ai-sdk/openai";

// Define the stream handler with your model and tools
export const chatAgentHandler = streamHandlerAction(components.durableAgents, {
  model: "anthropic/claude-haiku-4.5",
  system: "You are a helpful AI assistant.",
  tools: {
    get_weather: createActionTool({
      description: "Get weather for a location",
      args: z.object({ location: z.string() }),
      handler: internal.tools.weather.getWeather,
    }),
  },
  saveStreamDeltas: true, // Enable real-time streaming
});

// Export the agent API (public - callable from clients)
export const {
  createThread,
  sendMessage,
  getThread,
  listMessages,
  listMessagesWithStreams,
  listThreads,
  deleteThread,
  resumeThread,
  stopThread,
  addToolResult,
  addToolError,
} = defineAgentApi(components.durableAgents, internal.chat.chatAgentHandler, {
  // Optional: Add authorization to protect thread access
  authorizationCallback: async (ctx, threadId) => {
    // Example: verify the user owns this thread
    // const identity = await ctx.auth.getUserIdentity();
    // if (!identity) throw new Error("Unauthorized");
  },
});
```

#### Using Internal API

If you want to restrict the agent API to only be callable from other Convex functions (not directly from clients), use
`defineInternalAgentApi` instead:

```ts
// convex/chat.ts
import { defineInternalAgentApi } from "convex-durable-agents";

// Export internal agent API (only callable from other Convex functions)
export const {
  createThread,
  sendMessage,
  getThread,
  // ... other functions
} = defineInternalAgentApi(components.durableAgents, internal.chat.chatAgentHandler);
```

This is useful when you want to:

- Add authentication/authorization checks before calling agent functions
- Wrap agent functions with additional business logic
- Prevent direct client access to the agent API
- Run agents in the background

You can then create your own public functions that call the internal API:

```ts
// convex/myChat.ts
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Public wrapper with auth check
export const sendMessage = mutation({
  args: { threadId: v.string(), prompt: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Call the internal agent API
    return ctx.runMutation(internal.chat.sendMessage, args);
  },
});
```

### 3. Create Tool Handlers

Tools are defined as Convex actions:

```ts
// convex/tools/weather.ts
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

export const getWeather = internalAction({
  args: { location: v.string() },
  returns: v.object({ weather: v.string(), temperature: v.number() }),
  handler: async (_ctx, args) => {
    // Call your weather API here
    return { weather: "sunny", temperature: 72 };
  },
});
```

### 4. Build Your UI

Use the React hooks to build your chat interface:

```tsx
import { useAgentChat, getMessageKey } from "convex-durable-agents/react";
import { api } from "../convex/_generated/api";

function ChatView({ threadId }: { threadId: string }) {
  const { messages, status, isRunning, sendMessage, stop } = useAgentChat({
    listMessages: api.chat.listMessagesWithStreams,
    getThread: api.chat.getThread,
    sendMessage: api.chat.sendMessage,
    stopThread: api.chat.stopThread,
    resumeThread: api.chat.resumeThread,
    threadId,
  });

  return (
    <div>
      {messages.map((msg) => (
        <div key={getMessageKey(msg)}>
          <strong>{msg.role}:</strong> {msg.parts.map((p) => (p.type === "text" ? p.text : null))}
        </div>
      ))}

      {isRunning && <button onClick={() => stop()}>Stop</button>}

      <input
        onKeyPress={(e) => {
          if (e.key === "Enter" && !isRunning) {
            sendMessage(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
        disabled={isRunning}
      />
    </div>
  );
}
```

## API Reference

### Client API

#### `defineAgentApi(component, streamHandler, options?)`

Creates the full agent API with **public** functions that can be called directly from clients:

- `createThread({ prompt? })` - Create a new conversation thread
- `sendMessage({ threadId, prompt })` - Send a message to a thread
- `resumeThread({ threadId, prompt? })` - Resume a stopped/failed thread
- `stopThread({ threadId })` - Stop a running thread
- `getThread({ threadId })` - Get thread details
- `listMessages({ threadId })` - List messages in a thread
- `listMessagesWithStreams({ threadId, streamArgs? })` - List messages with streaming support
- `listThreads({ limit? })` - List all threads
- `deleteThread({ threadId })` - Delete a thread
- `addToolResult({ toolCallId, result })` - Add result for async tool
- `addToolError({ toolCallId, error })` - Add error for async tool

**Options:**

```ts
type AgentApiOptions = {
  authorizationCallback?: (ctx: QueryCtx | MutationCtx | ActionCtx, threadId: string) => Promise<void> | void;
  workpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
  toolExecutionWorkpoolEnqueueAction?: FunctionReference<"mutation", "internal">;
};
```

- `authorizationCallback` - Called before any operation that accesses an existing thread. Use it to verify the user has
  permission to access the thread. Throw an error to deny access.
- `workpoolEnqueueAction` - Route agent and tool execution through a workpool for parallelism control
- `toolExecutionWorkpoolEnqueueAction` - Override workpool for tool execution only (falls back to
  `workpoolEnqueueAction` if not set)

**Protected endpoints:** `sendMessage`, `resumeThread`, `stopThread`, `getThread`, `listMessages`,
`listMessagesWithStreams`, `deleteThread`

**Example with ownership check:**

```ts
defineAgentApi(components.durableAgents, internal.chat.chatAgentHandler, {
  authorizationCallback: async (ctx, threadId) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    // Query your threads table to verify ownership
    const thread = await ctx.runQuery(api.threads.getOwner, { threadId });
    if (thread?.userId !== identity.subject) {
      throw new Error("Access denied");
    }
  },
});
```

#### `defineInternalAgentApi(component, streamHandler, options?)`

Same as `defineAgentApi` but creates internal functions that can only be called from other Convex functions. Use this
when you want to add authentication, authorization, or other business logic before calling agent functions.

#### `streamHandlerAction(component, options)`

Creates the stream handler action:

```ts
streamHandlerAction(component, {
  model: languageModel,        // AI SDK language model
  system?: string,             // System prompt
  tools?: Record<string, DurableTool>,
  saveStreamDeltas?: boolean | StreamingOptions,
  transformMessages?: (messages) => messages,
  // ... other AI SDK streamText options
});
```

#### `createActionTool(options)`

Creates a sync tool that returns results directly:

```ts
createActionTool({
  description: string,
  args: ZodSchema,
  handler: FunctionReference<"action">,
});
```

#### `createAsyncTool(options)`

Creates an async tool where results are provided later:

```ts
createAsyncTool({
  description: string,
  args: ZodSchema,
  callback: FunctionReference<"action">,
});
```

### React Hooks

#### `useAgentChat(options)`

All-in-one hook for chat functionality that combines thread state with mutations:

```ts
const {
  messages, // UIMessage[]
  thread, // ThreadDoc | null
  status, // ThreadStatus
  isLoading, // boolean
  isRunning, // boolean
  isComplete, // boolean
  isFailed, // boolean
  isStopped, // boolean
  sendMessage, // (prompt: string) => Promise<null>
  stop, // () => Promise<null>
  resume, // (prompt?: string) => Promise<null>
} = useAgentChat({
  listMessages: api.chat.listMessagesWithStreams,
  getThread: api.chat.getThread,
  sendMessage: api.chat.sendMessage,
  stopThread: api.chat.stopThread,
  resumeThread: api.chat.resumeThread,
  threadId,
  stream: true, // optional, defaults to true
});

// Send a message (threadId is automatically included)
await sendMessage("Hello!");

// Stop the agent
await stop();

// Resume after stopping or failure
await resume();
```

#### `useThread(messagesQuery, threadQuery, args, options?)`

Lower-level hook for thread status and messages (use `useAgentChat` for most cases):

```ts
const {
  messages, // UIMessage[]
  thread, // ThreadDoc | null
  status, // ThreadStatus
  isLoading, // boolean
  isRunning, // boolean
  isComplete, // boolean
  isFailed, // boolean
  isStopped, // boolean
} = useThread(api.chat.listMessagesWithStreams, api.chat.getThread, { threadId }, { stream: true });
```

#### `useSmoothText(text, options?)`

Smooth text animation for streaming:

```ts
const [visibleText, { cursor, isStreaming }] = useSmoothText(text, {
  charsPerSec: 128,
  startStreaming: true,
});
```

#### `useThreadStatus(query, args)`

Subscribe to thread status changes:

```ts
const { thread, status, isRunning, isComplete, isFailed, isStopped } = useThreadStatus(api.chat.getThread, {
  threadId,
});
```

#### `useMessages(query, threadQuery, args)`

Fetch and transform messages:

```ts
const { messages, isLoading, thread } = useMessages(api.chat.listMessages, api.chat.getThread, { threadId });
```

## Thread Status

Threads can be in one of these states:

- `streaming` - AI is generating a response
- `awaiting_tool_results` - Waiting for tool execution to complete
- `completed` - Conversation finished successfully
- `failed` - An error occurred
- `stopped` - User stopped the conversation

## Workpool Integration

For advanced use cases, you can route agent execution through the `@convex-dev/workpool` component. This provides:

- **Parallelism Control**: Limit concurrent AI model calls and tool executions
- **Retry Mechanisms**: Automatic retries with exponential backoff for failed actions
- **Rate Limiting Protection**: Prevent overwhelming external APIs

### Setup

1. Install and configure the workpool component:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import durableAgents from "convex-durable-agents/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();
app.use(durableAgents);
app.use(workpool, { name: "agentWorkpool" });

export default app;
```

2. Create the workpool bridge:

```ts
// convex/workpool.ts
import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";
import { createWorkpoolBridge } from "convex-durable-agents";

const pool = new Workpool(components.agentWorkpool, {
  maxParallelism: 5,
});

export const { enqueueWorkpoolAction } = createWorkpoolBridge(pool);
```

3. Pass the workpool to your agent API:

```ts
// convex/chat.ts
export const {
  createThread,
  sendMessage,
  // ...
} = defineAgentApi(components.durableAgents, internal.chat.chatAgentHandler, {
  workpoolEnqueueAction: internal.workpool.enqueueWorkpoolAction,
});
```

### Separate Workpools for Tools

You can use different workpools for the stream handler and tool execution:

```ts
// convex/workpool.ts
const agentPool = new Workpool(components.agentWorkpool, { maxParallelism: 3 });
const toolPool = new Workpool(components.toolWorkpool, { maxParallelism: 10 });

export const { enqueueWorkpoolAction: enqueueAgentAction } = createWorkpoolBridge(agentPool);
export const { enqueueWorkpoolAction: enqueueToolAction } = createWorkpoolBridge(toolPool);
```

```ts
// convex/chat.ts
defineAgentApi(components.durableAgents, internal.chat.chatAgentHandler, {
  workpoolEnqueueAction: internal.workpool.enqueueAgentAction,
  toolExecutionWorkpoolEnqueueAction: internal.workpool.enqueueToolAction,
});
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Application                        │
├─────────────────────────────────────────────────────────────┤
│  defineAgentApi()          │  React Hooks                   │
│  - createThread            │  - useAgentChat                │
│  - sendMessage             │  - useThread                   │
│  - stopThread              │  - useMessages                 │
│  - resumeThread            │  - useSmoothText               │
├─────────────────────────────────────────────────────────────┤
│                   Durable Agent Component                    │
├──────────────┬──────────────┬──────────────┬────────────────┤
│   threads    │   messages   │  tool_calls  │    streams     │
│   - status   │   - order    │  - result    │   - deltas     │
│   - stop     │   - content  │  - error     │   - state      │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

## Example

See the [example](./example) directory for a complete chat application.

Run the example:

```bash
npm install
npm run dev
```

## License

Apache-2.0
