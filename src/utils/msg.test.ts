import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { endsWithAssistantMessage } from "./msg";

describe("endsWithAssistantMessage", () => {
  it("returns false for empty arrays", () => {
    expect(endsWithAssistantMessage([])).toBe(false);
  });

  it("returns false when the last message is user", () => {
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(endsWithAssistantMessage(messages)).toBe(false);
  });

  it("returns false when the last message is tool", () => {
    const toolMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "foo", output: null }],
    } as unknown as ModelMessage;
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "calling tool" }] },
      toolMessage,
    ];
    expect(endsWithAssistantMessage(messages)).toBe(false);
  });

  it("returns true when the last message is assistant", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ];
    expect(endsWithAssistantMessage(messages)).toBe(true);
  });
});
