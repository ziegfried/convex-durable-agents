import { cronJobs } from "convex/server";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const crons = cronJobs();

export const recoverAgents = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(components.durable_agents.agent.tryContinueAllThreads, {});
    await ctx.runMutation(components.durable_agents.tool_calls.resumePendingSyncToolExecutions, {});
    return null;
  },
});

crons.interval("recoverAgents", { minutes: 1 }, internal.crons.recoverAgents);

export default crons;
