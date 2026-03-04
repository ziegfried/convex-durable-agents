import type { ModelMessage } from "ai";

export function endsWithAssistantMessage(messages: ModelMessage[]): boolean {
  if (messages.length === 0) {
    return false;
  }
  return messages[messages.length - 1]?.role === "assistant";
}
