import {
  type FunctionReference,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
  internalMutationGeneric,
} from "convex/server";
import { v } from "convex/values";

// ============================================================================
// Workpool Bridge Helper
// ============================================================================

/**
 * Type for a Workpool instance that has an enqueueAction method.
 * This is compatible with @convex-dev/workpool's Workpool class.
 */

type WorkpoolLike = {
  enqueueAction: (
    ctx: GenericMutationCtx<GenericDataModel>,
    fn: FunctionReference<"action", FunctionVisibility, any, any>,
    fnArgs: any,
    options?: any,
  ) => Promise<any>;
};

/**
 * Creates a workpool bridge mutation that can be used with defineAgentApi.
 *
 * This helper creates an internal mutation that forwards action execution to your workpool,
 * allowing the agent to use workpool's parallelism controls and retry mechanisms.
 *
 * @example
 * ```typescript
 * // convex/workpool.ts
 * import { Workpool } from "@convex-dev/workpool";
 * import { components } from "./_generated/api";
 * import { createWorkpoolBridge } from "convex-durable-agents";
 *
 * const pool = new Workpool(components.workpool, { maxParallelism: 5 });
 * export const { enqueueWorkpoolAction } = createWorkpoolBridge(pool);
 *
 * // convex/chat.ts
 * export const { createThread, sendMessage, ... } = defineAgentApi(
 *   components.durable_agents,
 *   internal.chat.chatAgentHandler,
 *   { workpoolEnqueueAction: internal.workpool.enqueueWorkpoolAction }
 * );
 * ```
 */
export function createWorkpoolBridge(workpool: WorkpoolLike) {
  return {
    enqueueWorkpoolAction: internalMutationGeneric({
      args: {
        action: v.string(),
        args: v.any(),
      },
      returns: v.null(),
      handler: async (ctx, { action, args }) => {
        await workpool.enqueueAction(
          ctx,
          action as unknown as FunctionReference<"action", "internal", Record<string, unknown>, unknown>,
          args as Record<string, unknown>,
        );
        return null;
      },
    }),
  };
}
