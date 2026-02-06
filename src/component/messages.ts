import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { vMessageContent, vMessageRole } from "./schema.js";

// Public message shape
export type MessageDoc = {
  _id: Id<"messages">;
  _creationTime: number;
  threadId: Id<"threads">;
  order: number;
  role: Doc<"messages">["role"];
  content: Doc<"messages">["content"];
};

function publicMessage(message: Doc<"messages">): MessageDoc {
  return {
    _id: message._id,
    _creationTime: message._creationTime,
    threadId: message.threadId,
    order: message.order,
    role: message.role,
    content: message.content,
  };
}

// Message doc validator for return types
export const vMessageDoc = v.object({
  _id: v.id("messages"),
  _creationTime: v.number(),
  threadId: v.id("threads"),
  order: v.number(),
  role: vMessageRole,
  content: vMessageContent,
});

export const add = mutation({
  args: {
    threadId: v.id("threads"),
    role: vMessageRole,
    content: vMessageContent,
  },
  returns: vMessageDoc,
  handler: async (ctx, args) => {
    // Get the next order number
    const lastMessage = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .first();

    const order = lastMessage ? lastMessage.order + 1 : 0;

    const messageId = await ctx.db.insert("messages", {
      threadId: args.threadId,
      order,
      role: args.role,
      content: args.content,
    });

    const message = await ctx.db.get(messageId);
    return publicMessage(message!);
  },
});

export const list = query({
  args: {
    threadId: v.id("threads"),
    excludeSystemMessages: v.optional(v.boolean()),
  },
  returns: v.array(vMessageDoc),
  handler: async (ctx, args) => {
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

    return messages.map(publicMessage);
  },
});
