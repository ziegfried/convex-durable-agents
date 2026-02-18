import { generateId, type UIMessagePart } from "ai";
import { v } from "convex/values";
import type { MessageDoc } from "../client/types.js";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { createToolOutcomePart } from "./tool_calls.js";

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

type ToolInputAvailablePart = {
  toolCallId: string;
  state: "input-available";
  callProviderMetadata?: unknown;
};

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isToolInputAvailablePart(part: unknown): part is ToolInputAvailablePart {
  return isObjectLike(part) && typeof part.toolCallId === "string" && part.state === "input-available";
}

// Message doc validator for return types
export const vMessageDoc = vUIMessage.extend({
  _id: v.string(),
  _creationTime: v.number(),
  threadId: v.string(),
  committedSeq: v.optional(v.number()),
});

export const add = mutation({
  args: {
    threadId: v.id("threads"),
    streaming: v.optional(v.boolean()),
    msg: vUIMessageOptId,
    overwrite: v.optional(v.boolean()),
    committedSeq: v.optional(v.number()),
  },
  returns: v.id("messages"),
  handler: async (ctx, args): Promise<Id<"messages">> => {
    if (!args.streaming) {
      const thread = await ctx.db.get(args.threadId);
      if (!thread) throw new Error(`Thread ${args.threadId} not found`);
      if (thread.status === "streaming" || thread.status === "awaiting_tool_results") {
        throw new Error(`Thread ${args.threadId} is ${thread.status}, cannot add message`);
      }
    }

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
          parts: args.msg.parts,
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

export const applyToolOutcomes = mutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.array(vMessageDoc),
  handler: async (ctx, args): Promise<MessageDoc[]> => {
    const result: MessageDoc[] = [];
    for await (const message of ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")) {
      let modified = false;
      const parts: UIMessagePart<any, any>[] = [];
      for (const part of message.parts as unknown[]) {
        if (isToolInputAvailablePart(part)) {
          const toolCall = await ctx.db
            .query("tool_calls")
            .withIndex("by_thread_tool_call_id", (q) =>
              q.eq("threadId", message.threadId).eq("toolCallId", part.toolCallId),
            )
            .unique();
          if (toolCall) {
            const completedToolCall = createToolOutcomePart(toolCall, part);
            if (completedToolCall != null) {
              parts.push(completedToolCall);
              modified = true;
              continue;
            }
          }
        }
        parts.push(part as UIMessagePart<any, any>);
      }
      if (modified) {
        await ctx.db.patch(message._id, { parts });
        result.push({ ...message, parts });
      } else {
        result.push(message);
      }
    }
    return result;
  },
});
