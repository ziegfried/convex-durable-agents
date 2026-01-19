import workpool from "@convex-dev/workpool/convex.config";
import durableAgents from "convex-durable-agents/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(durableAgents);
app.use(workpool, { name: "agentWorkpool" });

export default app;
