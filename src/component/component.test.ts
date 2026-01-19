/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("threads", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("create thread", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    expect(thread).toBeDefined();
    expect(thread._id).toBeDefined();
    expect(thread.status).toBe("completed");
    expect(thread.stopSignal).toBe(false);
    expect(thread.streamFnHandle).toBe("test-handle");
  });

  test("get thread", async () => {
    const t = initConvexTest();
    const created = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const thread = await t.query(api.threads.get, { threadId: created._id });
    expect(thread).toBeDefined();
    expect(thread?._id).toBe(created._id);
    expect(thread?.status).toBe("completed");
  });

  test("set thread status", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    await t.mutation(api.threads.setStatus, {
      threadId: thread._id,
      status: "completed",
    });
    const updated = await t.query(api.threads.get, { threadId: thread._id });
    expect(updated?.status).toBe("completed");
  });

  test("set stop signal", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    await t.mutation(api.threads.setStopSignal, {
      threadId: thread._id,
      stopSignal: true,
    });
    const updated = await t.query(api.threads.get, { threadId: thread._id });
    expect(updated?.stopSignal).toBe(true);
  });

  test("list threads", async () => {
    const t = initConvexTest();
    await t.mutation(api.threads.create, { streamFnHandle: "handle-1" });
    await t.mutation(api.threads.create, { streamFnHandle: "handle-2" });
    const threads = await t.query(api.threads.list, {});
    expect(threads.length).toBe(2);
  });

  test("remove thread", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    await t.mutation(api.threads.remove, { threadId: thread._id });
    const deleted = await t.query(api.threads.get, { threadId: thread._id });
    expect(deleted).toBeNull();
  });
});

describe("messages", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("add message", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const message = await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "user", content: "Hello, world!" },
    });
    expect(message).toBeDefined();
    expect(message.threadId).toBe(thread._id);
    expect(message.order).toBe(0);
    expect(message.message.role).toBe("user");
    expect(message.message.content).toBe("Hello, world!");
  });

  test("list messages in order", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "user", content: "First" },
    });
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "assistant", content: "Second" },
    });
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "user", content: "Third" },
    });
    const messages = await t.query(api.messages.list, { threadId: thread._id });
    expect(messages.length).toBe(3);
    expect(messages[0].order).toBe(0);
    expect(messages[1].order).toBe(1);
    expect(messages[2].order).toBe(2);
    expect(messages[0].message.content).toBe("First");
    expect(messages[1].message.content).toBe("Second");
    expect(messages[2].message.content).toBe("Third");
  });

  test("message with array content", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const message = await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "test",
            input: {},
          },
        ],
      },
    });
    expect(message.message.content).toHaveLength(2);
  });
});

describe("tool_calls", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("create tool call", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const toolCall = await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "call-123",
      toolName: "get_weather",
      args: { location: "San Francisco" },
    });
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCallId).toBe("call-123");
    expect(toolCall.toolName).toBe("get_weather");
    expect(toolCall.args).toEqual({ location: "San Francisco" });
    expect(toolCall.result).toBeUndefined();
    expect(toolCall.error).toBeUndefined();
  });

  test("set tool call result", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const toolCall = await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "call-123",
      toolName: "get_weather",
      args: { location: "San Francisco" },
    });
    await t.mutation(api.tool_calls.setResult, {
      id: toolCall._id,
      result: { weather: "sunny", temperature: 72 },
    });
    const updated = await t.query(api.tool_calls.getByToolCallId, {
      threadId: thread._id,
      toolCallId: "call-123",
    });
    expect(updated?.result).toEqual({ weather: "sunny", temperature: 72 });
  });

  test("set tool call error", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const toolCall = await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "call-123",
      toolName: "get_weather",
      args: { location: "Unknown" },
    });
    await t.mutation(api.tool_calls.setError, {
      id: toolCall._id,
      error: "Location not found",
    });
    const updated = await t.query(api.tool_calls.getByToolCallId, {
      threadId: thread._id,
      toolCallId: "call-123",
    });
    expect(updated?.error).toBe("Location not found");
  });

  test("list pending tool calls", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    const tc1 = await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "call-1",
      toolName: "tool1",
      args: {},
    });
    await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "call-2",
      toolName: "tool2",
      args: {},
    });

    // Both should be pending
    let pending = await t.query(api.tool_calls.listPending, {
      threadId: thread._id,
    });
    expect(pending.length).toBe(2);

    // Complete one
    await t.mutation(api.tool_calls.setResult, {
      id: tc1._id,
      result: "done",
    });

    // Only one should be pending
    pending = await t.query(api.tool_calls.listPending, {
      threadId: thread._id,
    });
    expect(pending.length).toBe(1);
    expect(pending[0].toolCallId).toBe("call-2");
  });
});

describe("agent flow", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("full conversation flow simulation", async () => {
    const t = initConvexTest();

    // Create thread
    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });
    expect(thread.status).toBe("completed");

    // Add user message
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: {
        role: "user",
        content: "What's the weather in San Francisco?",
      },
    });

    // Simulate assistant response with tool call
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "weather-call-sf",
            toolName: "get_weather",
            input: { location: "San Francisco" },
          },
        ],
      },
    });

    // Update thread status to awaiting tool results
    await t.mutation(api.threads.setStatus, {
      threadId: thread._id,
      status: "awaiting_tool_results",
    });

    // Create tool call record
    const toolCall = await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "weather-call-sf",
      toolName: "get_weather",
      args: { location: "San Francisco" },
    });

    // Set tool result
    await t.mutation(api.tool_calls.setResult, {
      id: toolCall._id,
      result: { weather: "sunny", temperature: 72 },
    });

    // Add tool result message
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "weather-call-sf",
            toolName: "get_weather",
            output: {
              type: "json",
              value: { weather: "sunny", temperature: 72 },
            },
          },
        ],
      },
    });

    // Add final assistant response
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: {
        role: "assistant",
        content: "The weather in San Francisco is sunny with a temperature of 72°F.",
      },
    });

    // Mark as completed
    await t.mutation(api.threads.setStatus, {
      threadId: thread._id,
      status: "completed",
    });

    // Verify final state
    const finalThread = await t.query(api.threads.get, {
      threadId: thread._id,
    });
    expect(finalThread?.status).toBe("completed");

    const messages = await t.query(api.messages.list, { threadId: thread._id });
    expect(messages.length).toBe(4);
    expect(messages[0].message.role).toBe("user");
    expect(messages[1].message.role).toBe("assistant");
    expect(messages[2].message.role).toBe("tool");
    expect(messages[3].message.role).toBe("assistant");
  });

  test("thread stop signal", async () => {
    const t = initConvexTest();

    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });

    // Set stop signal
    await t.mutation(api.threads.setStopSignal, {
      threadId: thread._id,
      stopSignal: true,
    });

    const updated = await t.query(api.threads.get, { threadId: thread._id });
    expect(updated?.stopSignal).toBe(true);
  });

  test("thread resume after stop", async () => {
    const t = initConvexTest();

    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });

    // Set to stopped
    await t.mutation(api.threads.setStatus, {
      threadId: thread._id,
      status: "stopped",
    });

    // Add a user message
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "user", content: "Continue please" },
    });

    // Resume
    await t.mutation(api.threads.resume, { threadId: thread._id });

    const updated = await t.query(api.threads.get, { threadId: thread._id });
    expect(updated?.status).toBe("streaming");
    expect(updated?.stopSignal).toBe(false);
  });

  test("remove thread cleans up messages and tool calls", async () => {
    const t = initConvexTest();

    const thread = await t.mutation(api.threads.create, {
      streamFnHandle: "test-handle",
    });

    // Add messages
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "user", content: "Hello" },
    });
    await t.mutation(api.messages.add, {
      threadId: thread._id,
      message: { role: "assistant", content: "Hi there!" },
    });

    // Add tool call
    await t.mutation(api.tool_calls.create, {
      threadId: thread._id,
      toolCallId: "call-1",
      toolName: "test",
      args: {},
    });

    // Remove thread
    await t.mutation(api.threads.remove, { threadId: thread._id });

    // Verify thread is gone
    const deletedThread = await t.query(api.threads.get, {
      threadId: thread._id,
    });
    expect(deletedThread).toBeNull();

    // Verify messages are gone
    const messages = await t.query(api.messages.list, { threadId: thread._id });
    expect(messages.length).toBe(0);

    // Verify tool calls are gone
    const toolCalls = await t.query(api.tool_calls.listPending, {
      threadId: thread._id,
    });
    expect(toolCalls.length).toBe(0);
  });
});
