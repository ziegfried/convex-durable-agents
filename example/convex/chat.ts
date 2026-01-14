import { z } from "zod";
import { components, internal } from "./_generated/api.js";
import {
  createActionTool,
  createAsyncTool,
  defineAgentApi,
  streamHandlerAction,
} from "convex-durable-agents";

// Note: In a real app, you would configure your AI model here.
// This example uses a placeholder - you'll need to set up your own model.
// 
// Example with OpenAI:
// import { openai } from "@ai-sdk/openai";
// const model = openai("gpt-4o");
//
// Example with Anthropic:
// import { anthropic } from "@ai-sdk/anthropic";
// const model = anthropic("claude-sonnet-4-20250514");

/**
 * The chat agent handler - processes messages and generates responses.
 * This is an internal action that gets scheduled by the component.
 */
export const chatAgentHandler = streamHandlerAction(components.durable_agent, {
  model: 'anthropic/claude-sonnet-4.5',
  system: `You are a helpful, friendly AI assistant. 
    You can help users with various tasks and answer their questions.
    Be concise but thorough in your responses.
    When checking the weather, always provide both the conditions and temperature.`,
  tools: {
    get_weather: createActionTool({
      description: "Get the current weather conditions for a given location",
      args: z.object({
        location: z.string().describe("The city name to get weather for"),
      }),
      handler: internal.tools.weather.getWeather,
    }),
    get_temperature: createAsyncTool({
      description: "Get the temperature for a given location (async operation)",
      args: z.object({
        location: z.string().describe("The city name to get temperature for"),
      }),
      callback: internal.tools.weather.invokeGetTemperature,
    }),
  },
  // Enable streaming deltas for real-time UI updates
  saveStreamDeltas: true,
});

/**
 * Export the agent API functions.
 * These are the public functions that your app will call.
 */
export const {
  getThread,
  listMessages,
  listMessagesWithStreams,
  listThreads,
  deleteThread,
  createThread,
  sendMessage,
  resumeThread,
  stopThread,
  addToolError,
  addToolResult,
} = defineAgentApi(components.durable_agent, internal.chat.chatAgentHandler);
