import { createFunctionHandle, type FunctionReference } from "convex/server";
import { z } from "zod";
import type { AsyncTool, DurableTool, SyncTool } from "./types.js";

// ============================================================================
// Tool Definition Helpers
// ============================================================================

/**
 * Create a sync durable tool definition - the handler returns the result directly
 */
export function createActionTool<INPUT, OUTPUT>(def: {
  description: string;
  args: z.ZodType<INPUT>;
  handler: FunctionReference<"action", "internal" | "public">;
}): SyncTool<INPUT, OUTPUT> {
  // Convert the Zod schema to JSON Schema format using Zod v4's native method
  const jsonSchemaObj = z.toJSONSchema(def.args) as Record<string, unknown>;
  // Remove $schema field as Convex doesn't allow fields starting with $
  const { $schema: _, ...cleanSchema } = jsonSchemaObj;
  return {
    type: "sync",
    description: def.description,
    parameters: cleanSchema,
    handler: def.handler,
  };
}

/**
 * Create an async durable tool definition - the callback is notified of the tool call,
 * but does NOT return the result. The result must be provided later via addToolResult().
 */
export function createAsyncTool<INPUT>(def: {
  description: string;
  args: z.ZodType<INPUT>;
  callback: FunctionReference<"action", "internal" | "public">;
}): AsyncTool<INPUT> {
  // Convert the Zod schema to JSON Schema format using Zod v4's native method
  const jsonSchemaObj = z.toJSONSchema(def.args) as Record<string, unknown>;
  // Remove $schema field as Convex doesn't allow fields starting with $
  const { $schema: _, ...cleanSchema } = jsonSchemaObj;
  return {
    type: "async",
    description: def.description,
    parameters: cleanSchema,
    callback: def.callback,
  };
}

// ============================================================================
// Tool Definition Building
// ============================================================================

// Internal tool definition with serialized function handles
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
} & ({ type: "sync"; handler: string } | { type: "async"; callback: string });

export async function buildToolDefinitions(tools: Record<string, DurableTool>): Promise<Array<ToolDefinition>> {
  if (!tools) return [];

  const makeToolDef = async (name: string, tool: DurableTool): Promise<ToolDefinition> => {
    if (tool.type === "sync") {
      return {
        type: "sync",
        name,
        description: tool.description,
        parameters: tool.parameters,
        handler: await serializeFunctionRef(tool.handler),
      };
    }
    return {
      type: "async",
      name,
      description: tool.description,
      parameters: tool.parameters,
      callback: await serializeFunctionRef(tool.callback),
    };
  };

  return await Promise.all(Object.entries(tools).map(([name, tool]) => makeToolDef(name, tool)));
}

/**
 * Serialize a function reference to a string
 */
async function serializeFunctionRef(ref: FunctionReference<"action", "internal" | "public">): Promise<string> {
  const handle = await createFunctionHandle(ref);
  return handle.toString();
}
