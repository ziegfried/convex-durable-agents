import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { vMessage } from "./schema.js";

// Public message shape
export type MessageDoc = {
  _id: Id<"messages">;
  _creationTime: number;
  threadId: Id<"threads">;
  order: number;
  message: Doc<"messages">["message"];
};

function publicMessage(message: Doc<"messages">): MessageDoc {
  return {
    _id: message._id,
    _creationTime: message._creationTime,
    threadId: message.threadId,
    order: message.order,
    message: message.message,
  };
}

// Message doc validator for return types
export const vMessageDoc = v.object({
  _id: v.id("messages"),
  _creationTime: v.number(),
  threadId: v.id("threads"),
  order: v.number(),
  message: vMessage,
});

export const add = mutation({
  args: {
    threadId: v.id("threads"),
    message: vMessage,
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
      message: args.message,
    });

    const message = await ctx.db.get(messageId);
    return publicMessage(message!);
  },
});

export const list = query({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.array(vMessageDoc),
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();

    return messages.map(publicMessage);
  },
});
