import { defineApp } from "convex/server";
import durableAgents from "convex-durable-agents/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config";

const app = defineApp();
app.use(durableAgents);
app.use(workpool, { name: "agentWorkpool" });

export default app;
