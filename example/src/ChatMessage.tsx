import { getMessageText, getMessageStatus, type UIMessage, type DynamicToolUIPart } from "convex-durable-agents/react";
import { SmoothText } from "./SmoothText";

/**
 * Single chat message component
 */
export function ChatMessage({ message }: { message: UIMessage }) {
  const status = getMessageStatus(message);
  const isStreaming = status === "streaming" || status === "awaiting_tool_results";

  // Extract text content using helper
  const textContent = getMessageText(message);

  // Extract tool invocations (AI SDK's DynamicToolUIPart format)
  const toolInvocations = message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool");

  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: "1rem",
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "0.75rem 1rem",
          borderRadius: "1rem",
          backgroundColor: isUser ? "#3b82f6" : "#f3f4f6",
          color: isUser ? "white" : "black",
        }}
      >
        {/* Tool invocations */}
        {toolInvocations.map((tc) => (
          <div
            key={tc.toolCallId}
            style={{
              marginBottom: "0.5rem",
              padding: "0.5rem",
              borderRadius: "0.5rem",
              backgroundColor: "rgba(0,0,0,0.1)",
              fontSize: "0.875rem",
            }}
          >
            <div style={{ fontWeight: "bold", marginBottom: "0.25rem" }}>
              🔧 {tc.toolName}
              {tc.state === "output-available" ? " ✓" : " ..."}
            </div>
            {tc.state === "output-available" && tc.output !== undefined && (
              <pre style={{ margin: 0, fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
                {JSON.stringify(tc.output, null, 2)}
              </pre>
            )}
          </div>
        ))}

        {/* Text content */}
        {textContent && (
          <div style={{ whiteSpace: "pre-wrap" }}>
            <SmoothText text={textContent} isStreaming={isStreaming} />
          </div>
        )}

        {/* Loading indicator */}
        {isStreaming && !textContent && toolInvocations.length === 0 && (
          <div style={{ color: "rgba(0,0,0,0.5)" }}>Thinking...</div>
        )}
      </div>
    </div>
  );
}
