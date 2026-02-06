import type { UIMessage as AIUIMessage, TextUIPart } from "ai";

export type ThreadStatus = "streaming" | "awaiting_tool_results" | "completed" | "failed" | "stopped";

// Metadata type for custom fields in UIMessage
export type ConvexUIMessageMetadata = {
  key: string;
  order: number;
  status: ThreadStatus | "success";
  _creationTime: number;
};

// UI-friendly message format using AI SDK's UIMessage with custom metadata
export type UIMessage = AIUIMessage<ConvexUIMessageMetadata>;

// Tool part type matching AI SDK's ToolUIPart format (type: "tool-{toolName}")
// Uses discriminated union to match AI SDK's type structure
export type ToolCallUIPart =
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "input-streaming";
      input: unknown | undefined;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "input-available";
      input: unknown;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "output-available";
      input: unknown;
      output: unknown;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: "output-error";
      input: unknown;
      errorText: string;
    };

function isToolPart(part: unknown): part is ToolCallUIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof (part as { type: unknown }).type === "string" &&
    (part as { type: string }).type.startsWith("tool-")
  );
}

/**
 * Combine consecutive assistant messages by merging tool results.
 * This merges tool-call parts (input-available) with their corresponding tool-result parts (output-available)
 * by matching toolCallId.
 */
export function combineUIMessages(messages: UIMessage[]): UIMessage[] {
  return messages.reduce((acc, message) => {
    if (!acc.length) return [message];
    const previous = acc[acc.length - 1];
    if (!previous) return [message];

    // Check if current message has tool results that match tool calls in previous message
    const prevToolCallIds = new Set(
      previous?.parts
        .filter((p): p is ToolCallUIPart => isToolPart(p) && p.state === "input-available")
        .map((p) => p.toolCallId),
    );

    const currToolResults = message.parts.filter(
      (p): p is ToolCallUIPart =>
        isToolPart(p) &&
        (p.state === "output-available" || p.state === "output-error") &&
        prevToolCallIds.has(p.toolCallId),
    );

    // If there are matching tool results, merge the messages
    if (currToolResults.length > 0) {
      const newParts = [...(previous?.parts ?? [])] as Array<TextUIPart | ToolCallUIPart>;

      for (const part of message.parts) {
        if (isToolPart(part) && (part.state === "output-available" || part.state === "output-error")) {
          const toolPart = part as ToolCallUIPart & ({ state: "output-available" } | { state: "output-error" });
          const existingIdx = newParts.findIndex(
            (p) => isToolPart(p) && p.toolCallId === toolPart.toolCallId && p.state === "input-available",
          );
          if (existingIdx !== -1) {
            const existing = newParts[existingIdx] as ToolCallUIPart & { state: "input-available" };
            if (toolPart.state === "output-error") {
              newParts[existingIdx] = {
                type: existing.type,
                toolCallId: existing.toolCallId,
                state: "output-error",
                input: existing.input,
                errorText: toolPart.errorText,
              };
            } else {
              newParts[existingIdx] = {
                type: existing.type,
                toolCallId: existing.toolCallId,
                state: "output-available",
                input: existing.input,
                output: toolPart.output,
              };
            }
            continue;
          }
        }
        newParts.push(part as TextUIPart | ToolCallUIPart);
      }

      const newStatus = message.metadata?.status === "success" ? previous.metadata?.status : message.metadata?.status;

      acc[acc.length - 1] = {
        ...previous,
        parts: newParts,
        metadata: {
          ...previous.metadata!,
          status: newStatus ?? "success",
        },
      };
      return acc;
    }

    acc.push(message);
    return acc;
  }, [] as UIMessage[]);
}

export function getOrder(message: UIMessage): number | undefined {
  return message.metadata?.order;
}

export function isStreamMessage(message: UIMessage): boolean {
  return message.id.startsWith("stream:");
}

export function getDbMessageOrders(messages: UIMessage[]): Set<number> {
  const orders = new Set<number>();
  for (const message of messages) {
    const order = getOrder(message);
    if (order !== undefined) {
      orders.add(order);
    }
  }
  return orders;
}

export function filterFinishedStreamMessages(
  streamMessages: Array<UIMessage>,
  dbMessageOrders: Set<number>,
): Array<UIMessage> {
  return streamMessages.filter((message) => {
    if (message.metadata?.status === "streaming") return true;
    const order = getOrder(message);
    if (order === undefined) return true;
    return !dbMessageOrders.has(order);
  });
}

/**
 * Dedupe messages by order, preferring non-stream messages
 */
export function dedupeMessages(messages: Array<UIMessage>, streamMessages: Array<UIMessage>): Array<UIMessage> {
  const combined = [...messages, ...streamMessages].sort((a, b) => {
    const aOrder = a.metadata?.order ?? 0;
    const bOrder = b.metadata?.order ?? 0;
    return aOrder - bOrder;
  });
  return combined.reduce(
    (msgs, msg) => {
      const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      if (!last) {
        return [msg];
      }
      const lastOrder = getOrder(last);
      const msgOrder = getOrder(msg);
      if (lastOrder !== msgOrder) {
        msgs.push(msg);
        return msgs;
      }
      // Same order - check if we should replace
      const lastIsStream = isStreamMessage(last);
      const msgIsStream = isStreamMessage(msg);
      if (lastIsStream !== msgIsStream) {
        return lastIsStream ? [...msgs.slice(0, -1), msg] : msgs;
      }
      const lastStatus = last.metadata?.status;
      const msgStatus = msg.metadata?.status;
      if ((lastStatus === "streaming" || lastStatus === "awaiting_tool_results") && msgStatus === "success") {
        return [...msgs.slice(0, -1), msg];
      }
      return msgs;
    },
    [] as Array<UIMessage>,
  );
}
