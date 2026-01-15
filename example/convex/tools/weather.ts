import { v } from "convex/values";
import { internalAction } from "../_generated/server.js";
import { api, internal } from "../_generated/api.js";

/**
 * Get weather for a location
 * This is a durable tool handler - it runs as a separate action
 */
export const getWeather = internalAction({
  args: { location: v.string() },
  returns: v.object({ weather: v.string() }),
  handler: async (_ctx, args) => {
    // Simulate a weather API call
    console.log(`Getting weather for: ${args.location}`);

    // In a real implementation, this would call a weather API
    // For demo purposes, return mock data based on location
    const weatherData: Record<string, { weather: string }> = {
      London: { weather: "rainy" },
      "New York": { weather: "cloudy" },
      "San Francisco": { weather: "foggy" },
      Tokyo: { weather: "clear" },
      Vienna: { weather: "clear" },
    };

    return weatherData[args.location] ?? { weather: "unknown" };
  },
});

/**
 * Async tool callback example - invoked when the tool is called,
 * but the result is provided later via addToolResult
 */
export const invokeGetTemperature = internalAction({
  args: {
    threadId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    args: v.object({ location: v.string() }),
  },
  returns: v.null(),
  handler: async (ctx, { args, toolCallId }) => {
    console.log(`Invoking get temperature for: ${args.location}`);

    // Simulate an async operation - in real use this might:
    // - Start a long-running job
    // - Wait for webhook to be called
    // - Send a notification and wait for human input

    // For demo, we schedule the result to be added after a delay
    await ctx.scheduler.runAfter(2000, internal.tools.weather.addTemperatureResult, {
      location: args.location,
      toolCallId: toolCallId,
    });

    return null;
  },
});

/**
 * Add temperature result after async processing
 */
export const addTemperatureResult = internalAction({
  args: { location: v.string(), toolCallId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log(`Adding temperature result for: ${args.location}`);

    const temperatures: Record<string, number> = {
      London: 55,
      "New York": 65,
      "San Francisco": 72,
      Tokyo: 78,
      Vienna: 23,
    };

    const temp = temperatures[args.location];
    if (temp !== undefined) {
      await ctx.runMutation(api.chat.addToolResult, {
        toolCallId: args.toolCallId,
        result: { temperature_f: temp },
      });
    } else {
      await ctx.runMutation(api.chat.addToolError, {
        toolCallId: args.toolCallId,
        error: "Location not found",
      });
    }

    return null;
  },
});
