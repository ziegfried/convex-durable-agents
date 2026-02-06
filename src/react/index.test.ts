import { describe, expect, it } from "vitest";
import type { ThreadStatus, ToolCallUIPart, UIMessage } from "./message-utils";
import { combineUIMessages, dedupeMessages, filterFinishedStreamMessages, getDbMessageOrders } from "./message-utils";

type MessageInput = {
  id: string;
  order: number;
  status?: ThreadStatus | "success";
  role?: UIMessage["role"];
  parts?: UIMessage["parts"];
};

const makeMessage = ({ id, order, status = "success", role = "assistant", parts = [] }: MessageInput): UIMessage =>
  ({
    id,
    role,
    parts,
    metadata: {
      key: `k-${order}`,
      order,
      status,
      _creationTime: 0,
    },
  }) as UIMessage;

describe("durable-agents react helpers", () => {
  it("filters finished stream messages using raw db orders", () => {
    const toolCallId = "call-1";
    const toolCall: ToolCallUIPart = {
      type: "tool-test",
      toolCallId,
      state: "input-available",
      input: {},
    };
    const toolResult: ToolCallUIPart = {
      type: "tool-test",
      toolCallId,
      state: "output-available",
      input: {},
      output: { ok: true },
    };

    const callMessage = makeMessage({ id: "db-1", order: 1, parts: [toolCall] });
    const resultMessage = makeMessage({ id: "db-2", order: 2, parts: [toolResult] });

    const combined = combineUIMessages([callMessage, resultMessage]);
    expect(combined).toHaveLength(1);

    const dbOrders = getDbMessageOrders([callMessage, resultMessage]);
    expect(dbOrders.has(1)).toBe(true);
    expect(dbOrders.has(2)).toBe(true);

    const finishedStream = makeMessage({ id: "stream:abc", order: 2, status: "success" });
    const filtered = filterFinishedStreamMessages([finishedStream], dbOrders);
    expect(filtered).toHaveLength(0);

    const streamingStream = makeMessage({ id: "stream:def", order: 2, status: "streaming" });
    const kept = filterFinishedStreamMessages([streamingStream], dbOrders);
    expect(kept).toHaveLength(1);
  });

  it("prefers persisted messages over stream placeholders for the same order", () => {
    const dbMessage = makeMessage({ id: "db-1", order: 3 });
    const streamMessage = makeMessage({ id: "stream:xyz", order: 3 });

    const result = dedupeMessages([dbMessage], [streamMessage]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("db-1");
  });

  it("replaces streaming entries with success for the same order", () => {
    const streaming = makeMessage({ id: "stream:1", order: 4, status: "streaming" });
    const success = makeMessage({ id: "stream:2", order: 4, status: "success" });

    const result = dedupeMessages([], [streaming, success]);
    expect(result).toHaveLength(1);
    expect(result[0]?.metadata?.status).toBe("success");
  });
});
