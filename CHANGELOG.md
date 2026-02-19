# Changelog

## 0.2.4

- Automatic retries for common failures/interruptions of AI streams
- Automatic retries of failed/interrupted tool calls (opt-in)

## 0.2.3

- Enhance message handling and streaming functionality

## 0.2.2

- Optimistic update when sending chat messages

## 0.2.1

- Minor stream handling and tool calling improvements

## 0.2.0

- **Breaking API and database schema changes**
- Rewrite of streaming message updates (simplified data model, using `UIMessageChunks` and `readUIMessageStream` on the client)
- `toolCallId`s are now unique per thread, some API methods now require `threadId`
- Tool calls time out after 30 minutes
- API `setToolCallTimeout` to dynamically change expiration for async tool calls
- Tool calls now get invoked a little earlier, as soon as we see `input-available` in the stream

## 0.1.8

- Simplified message table (breaking change)
- New usageHandler callback
- API now omits system messages by default, use `excludeSystemMessages: false` to revert to old behavior (breaking change)

## 0.1.7

- Minor tweaks to conform with convex component best practices

## 0.1.6

- Status callback options
- Emit tool call parts as tool-<toolName> rather than dynamic tool calls

## 0.1.5

- Update API to make createThread a mutation rather than an action

## 0.1.4

- streamHandlerAction args factory

## 0.1.3

- Use UIMessage type from AI SDK rather than a custom variant
- New `useAgentChat` hook that provides a simple, ergonomic API for creating chat user interfaces

## 0.1.2

- Workpool support

## 0.1.1

- Function to define internal agent API

## 0.1.0

- Initial release of Convex Durable Agents
- Thread-based conversation management with status tracking
- Support for sync and async tool execution
- Real-time streaming with delta updates
- React hooks for building chat UIs
- Automatic crash recovery and retry logic
