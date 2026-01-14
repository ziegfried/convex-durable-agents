import { defineApp } from "convex/server";
import durableAgents from "convex-durable-agents/convex.config.js";

const app = defineApp();
app.use(durableAgents);

export default app;
