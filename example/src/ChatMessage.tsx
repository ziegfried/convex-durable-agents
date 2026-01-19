import { getMessageText, getMessageStatus, type UIMessage, type ToolCallUIPart } from "convex-durable-agents/react";
import { SmoothText } from "./SmoothText";
import { useState } from "react";

/**
 * Helper to check if a part is a tool call
 */
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
 * Extract tool name from tool part type (e.g., "tool-getWeather" -> "getWeather")
 */
function getToolName(part: ToolCallUIPart): string {
  return part.type.replace(/^tool-/, "");
}

/**
 * Format a value for compact display
 */
function formatCompact(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value.length > 50 ? value.slice(0, 50) + "..." : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const str = JSON.stringify(value);
    return str.length > 60 ? str.slice(0, 60) + "..." : str;
  }
  return String(value);
}

/**
 * Tool call display component with collapsible details
 */
function ToolCallDisplay({ toolCall }: { toolCall: ToolCallUIPart }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = getToolName(toolCall);
  const isComplete = toolCall.state === "output-available";
  const hasError = toolCall.state === "output-error";
  const isPending = toolCall.state === "input-available" || toolCall.state === "input-streaming";

  // Determine status icon and color
  const getStatusDisplay = () => {
    if (isComplete) return { icon: "✓", color: "#10b981", bgColor: "#d1fae5" };
    if (hasError) return { icon: "✗", color: "#ef4444", bgColor: "#fee2e2" };
    return { icon: "⋯", color: "#6b7280", bgColor: "#f3f4f6" };
  };

  const { icon, color, bgColor } = getStatusDisplay();

  // Get output for completed tools
  const output = isComplete && "output" in toolCall ? toolCall.output : undefined;
  const errorText = hasError && "errorText" in toolCall ? toolCall.errorText : undefined;
  const hasInput = toolCall.input !== undefined && toolCall.input !== null;
  const hasDetails = isComplete || hasError || (isPending && hasInput);

  return (
    <div
      style={{
        marginBottom: "0.5rem",
        borderRadius: "0.5rem",
        border: `1px solid ${color}30`,
        backgroundColor: bgColor,
        overflow: "hidden",
      }}
    >
      {/* Header - clickable to expand/collapse */}
      <div
        onClick={() => hasDetails && setIsExpanded(!isExpanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem 0.75rem",
          backgroundColor: `${color}15`,
          cursor: hasDetails ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "1.25rem",
            height: "1.25rem",
            borderRadius: "50%",
            backgroundColor: color,
            color: "white",
            fontSize: "0.7rem",
            fontWeight: "bold",
          }}
        >
          {icon}
        </span>
        <span style={{ fontWeight: 600, fontSize: "0.875rem", color: "#374151" }}>{toolName}</span>

        {/* Compact result preview for completed tools */}
        {isComplete && output !== undefined && !isExpanded && (
          <span
            style={{
              marginLeft: "0.5rem",
              fontSize: "0.75rem",
              color: "#6b7280",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            → {formatCompact(output)}
          </span>
        )}

        {isPending && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: "0.75rem",
              color: "#6b7280",
            }}
          >
            Running...
          </span>
        )}

        {hasDetails && (
          <span
            style={{
              marginLeft: isPending ? "0.5rem" : "auto",
              fontSize: "0.75rem",
              color: "#9ca3af",
              transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
            }}
          >
            ▼
          </span>
        )}
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            fontSize: "0.75rem",
            borderTop: `1px solid ${color}20`,
          }}
        >
          {/* Input args - always show if available */}
          {hasInput && (
            <div style={{ marginBottom: output !== undefined || errorText ? "0.5rem" : 0 }}>
              <div style={{ color: "#6b7280", marginBottom: "0.25rem", fontWeight: 500 }}>Input:</div>
              <pre
                style={{
                  margin: 0,
                  padding: "0.5rem",
                  backgroundColor: "rgba(0,0,0,0.05)",
                  borderRadius: "0.25rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "#374151",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.7rem",
                }}
              >
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Output/Result */}
          {isComplete && output !== undefined && (
            <div>
              <div style={{ color: "#059669", marginBottom: "0.25rem", fontWeight: 500 }}>Result:</div>
              <pre
                style={{
                  margin: 0,
                  padding: "0.5rem",
                  backgroundColor: "rgba(16,185,129,0.1)",
                  borderRadius: "0.25rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "#065f46",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.7rem",
                }}
              >
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}

          {/* Error */}
          {hasError && errorText && (
            <div>
              <div style={{ color: "#dc2626", marginBottom: "0.25rem", fontWeight: 500 }}>Error:</div>
              <pre
                style={{
                  margin: 0,
                  padding: "0.5rem",
                  backgroundColor: "rgba(239,68,68,0.1)",
                  borderRadius: "0.25rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "#dc2626",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.7rem",
                }}
              >
                {errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single chat message component
 */
export function ChatMessage({ message }: { message: UIMessage }) {
  const status = getMessageStatus(message);
  const isStreaming = status === "streaming" || status === "awaiting_tool_results";

  // Extract text content using helper
  const textContent = getMessageText(message);

  // Extract tool invocations (parts with type starting with "tool-")
  const toolInvocations = message.parts.filter(isToolPart);

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
          <ToolCallDisplay key={tc.toolCallId} toolCall={tc} />
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
