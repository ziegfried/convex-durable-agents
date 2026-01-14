import { describe, expect, test } from "vitest";
import { createActionTool, createAsyncTool } from "./index.js";
import { z } from "zod";

describe("tool definition helpers", () => {
  test("createActionTool creates sync tool definition", () => {
    const tool = createActionTool({
      description: "Get weather for a location",
      args: z.object({ location: z.string() }),
      handler: "test-handler" as any,
    });

    expect(tool.type).toBe("sync");
    expect(tool.description).toBe("Get weather for a location");
    expect(tool.parameters).toBeDefined();
    expect(tool.handler).toBe("test-handler");
  });

  test("createAsyncTool creates async tool definition", () => {
    const tool = createAsyncTool({
      description: "Send notification",
      args: z.object({ message: z.string() }),
      callback: "test-callback" as any,
    });

    expect(tool.type).toBe("async");
    expect(tool.description).toBe("Send notification");
    expect(tool.parameters).toBeDefined();
    expect(tool.callback).toBe("test-callback");
  });

  test("tool parameters are converted to JSON schema", () => {
    const tool = createActionTool({
      description: "Test tool",
      args: z.object({
        name: z.string(),
        count: z.number(),
        optional: z.string().optional(),
      }),
      handler: "test-handler" as any,
    });

    const params = tool.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    expect(params.properties).toBeDefined();
    expect((params.properties as Record<string, unknown>).name).toBeDefined();
    expect((params.properties as Record<string, unknown>).count).toBeDefined();
  });
});
