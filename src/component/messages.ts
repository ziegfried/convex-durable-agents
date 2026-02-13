import { generateId, type UIMessagePart } from "ai";
import { v } from "convex/values";
import type { MessageDoc } from "../client/types.js";
import { mutation, query } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

const vUIMessageBase = v.object({
  role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant")),
  metadata: v.optional(v.any()),
  parts: v.array(v.any()),
});

export const vUIMessageOptId = vUIMessageBase.extend({
  id: v.optional(v.string()),
});

const vUIMessage = vUIMessageBase.extend({
  id: v.string(),
});

// Message doc validator for return types
export const vMessageDoc = vUIMessage.extend({
  _id: v.string(),
  _creationTime: v.number(),
  threadId: v.string(),
  committedSeq: v.optional(v.number()),
});

function preserveToolOutputs(existingParts: UIMessagePart<any, any>[], newParts: UIMessagePart<any, any>[]) {
  const toolOutputs = existingParts.filter((p) => 'toolCallId' in p && (p.state === 'output-available' || p.state === 'output-error' || p.state === 'output-denied'));
  if (toolOutputs.length > 0) {
    const toolOutputsMap = new Map<string, UIMessagePart<any, any>>(toolOutputs.map(p => [p.toolCallId, p]));    
    const replacedParts = newParts.map(p => 'toolCallId' in p  && toolOutputsMap.has(p.toolCallId) && !p.state.startsWith('output-') ? toolOutputsMap.get(p.toolCallId)! : p);
    const newPartsToolMap = new Map(newParts.filter(p => 'toolCallId' in p).map(p => [p.toolCallId, p]));
    return replacedParts.concat(toolOutputs.filter(p => !newPartsToolMap.has(p.toolCallId)));
  }
  return newParts;
}

export const add = mutation({
  args: {
    threadId: v.id("threads"),
    msg: vUIMessageOptId,
    overwrite: v.optional(v.boolean()),
    committedSeq: v.optional(v.number()),
    preserveToolOutputs: v.optional(v.boolean()),
  },
  returns: v.id('messages'),
  handler: async (ctx, args): Promise<Id<'messages'>> => {
    const existingMessage = args.msg.id
      ? await ctx.db
          .query("messages")
          .withIndex("by_msg_id", (q) => q.eq("threadId", args.threadId).eq("id", args.msg.id!))
          .first()
      : null;

    if (existingMessage) {
      if (args.overwrite) {
        await ctx.db.patch(existingMessage._id, {
          role: args.msg.role,
          parts: args.preserveToolOutputs ? preserveToolOutputs(existingMessage.parts, args.msg.parts) : args.msg.parts,
          committedSeq: args.committedSeq,
        });
        return existingMessage._id;
      }
      throw new Error(`Message ${args.msg.id} already exists`);
    }
    const newMessageId = await ctx.db.insert("messages", {
      threadId: args.threadId,
      id: args.msg.id ?? generateId(),
      role: args.msg.role,
      parts: args.msg.parts,
      committedSeq: args.committedSeq,
    });
    return newMessageId;
  },
});

export const appendPart = mutation({
  args: {
    threadId: v.id("threads"),
    msgId: v.string(),
    part: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const existingMessage = await ctx.db
      .query("messages")
      .withIndex("by_msg_id", (q) => q.eq("threadId", args.threadId).eq("id", args.msgId))
      .first();
    if (!existingMessage) {
      throw new Error(`Message ${args.msgId} not found`);
    }
    await ctx.db.patch(existingMessage._id, { parts: [...existingMessage.parts, args.part] });
  },
});

export const appendToolOutcomePart = mutation({
  args: {
    threadId: v.id("threads"),
    msgId: v.string(),
    toolCallId: v.string(),
    part: v.any(),
    throwOnMissingToolCallPart: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    console.log("appendToolOutcomePart", args.toolCallId, args.msgId);
    const existingMessage = await ctx.db
      .query("messages")
      .withIndex("by_msg_id", (q) => q.eq("threadId", args.threadId).eq("id", args.msgId))
      .first();
    if (!existingMessage) {
      throw new Error(`Message ${args.msgId} not found`);
    }

    console.log("appendToolOutcomePart 2", existingMessage.parts.some((p) => p.toolCallId === args.toolCallId));
    console.log(args.part);
    if (existingMessage.parts.some((p) => p.toolCallId === args.toolCallId)) {
      await ctx.db.patch(existingMessage._id, {
        parts: existingMessage.parts.map((p) => {
          if (p.toolCallId !== args.toolCallId) return p;
          // Preserve callProviderMetadata from the original tool-call part (e.g. Gemini's
          // thoughtSignature) so that convertToModelMessages can reconstruct providerOptions
          // on the next model invocation.
          const preserved: Record<string, unknown> = {};
          if (p.callProviderMetadata != null && args.part.callProviderMetadata == null) {
            preserved.callProviderMetadata = p.callProviderMetadata;
          }
          return Object.keys(preserved).length > 0 ? { ...args.part, ...preserved } : args.part;
        }),
      });
    } else {
      if (args.throwOnMissingToolCallPart) {
        throw new Error(`Tool call part ${args.toolCallId} not found in message ${args.msgId}`);
      }
      // Append it if no tool call part with ID exists
      await ctx.db.patch(existingMessage._id, { parts: [...existingMessage.parts, args.part] });
    }
  },
});

export const list = query({
  args: {
    threadId: v.id("threads"),
    excludeSystemMessages: v.optional(v.boolean()),
  },
  returns: v.array(vMessageDoc),
  handler: async (ctx, args): Promise<MessageDoc[]> => {
    const messages = await (args.excludeSystemMessages
      ? ctx.db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
          .order("asc")
          .filter((q) => q.neq(q.field("role"), "system"))
          .collect()
      : ctx.db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
          .order("asc")
          .collect());

    return messages;
  },
});
