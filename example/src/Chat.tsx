import { api } from "../convex/_generated/api";
import { useState, useRef, useEffect } from "react";
import { useAgentChat, getMessageKey } from "convex-durable-agents/react";
import { ChatMessage } from "./ChatMessage";
import { StatusBadge } from "./StatusBadge";

/**
 * Chat view component
 */
export function Chat({ threadId }: { threadId: string }) {
  const { messages, status, isLoading, isRunning, isFailed, isStopped, sendMessage, stop, resume } = useAgentChat({
    listMessages: api.chat.listMessagesWithStreams,
    getThread: api.chat.getThread,
    sendMessage: api.chat.sendMessage,
    stopThread: api.chat.stopThread,
    resumeThread: api.chat.resumeThread,
    threadId,
  });

  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSubmitting || isRunning) return;

    setIsSubmitting(true);
    try {
      await sendMessage({ threadId, prompt: input.trim() });
      setInput("");
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = async () => {
    try {
      await stop({ threadId });
    } catch (error) {
      console.error("Failed to stop thread:", error);
    }
  };

  const handleRetry = async () => {
    try {
      await resume({ threadId });
    } catch (error) {
      console.error("Failed to retry:", error);
    }
  };

  return (
    <div data-testid="chat-view" style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          padding: "1rem",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ margin: 0 }}>Chat</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {status && <StatusBadge status={status} />}
          {isRunning && (
            <button
              onClick={handleStop}
              style={{
                padding: "0.5rem 1rem",
                backgroundColor: "#ef4444",
                color: "white",
                border: "none",
                borderRadius: "0.25rem",
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          )}
          {(isFailed || isStopped) && (
            <button
              onClick={handleRetry}
              style={{
                padding: "0.5rem 1rem",
                backgroundColor: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: "0.25rem",
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
        {isLoading && <div style={{ textAlign: "center", color: "#9ca3af" }}>Loading...</div>}

        {!isLoading && messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#9ca3af", padding: "2rem" }}>
            <p>No messages yet. Start the conversation!</p>
            <p style={{ fontSize: "0.875rem" }}>Try asking: "What's the weather in San Francisco?"</p>
          </div>
        )}

        {messages.map((message) => (
          <ChatMessage key={getMessageKey(message)} message={message} />
        ))}

        {isFailed && (
          <div
            style={{
              padding: "1rem",
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "0.5rem",
              color: "#dc2626",
              marginTop: "1rem",
            }}
          >
            An error occurred. Click retry to try again.
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          padding: "1rem",
          borderTop: "1px solid #e5e7eb",
          display: "flex",
          gap: "0.5rem",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isRunning ? "Waiting for response..." : "Type a message..."}
          disabled={isSubmitting || isRunning}
          style={{
            flex: 1,
            padding: "0.75rem",
            border: "1px solid #e5e7eb",
            borderRadius: "0.5rem",
            fontSize: "1rem",
          }}
        />
        <button
          type="submit"
          disabled={isSubmitting || isRunning || !input.trim()}
          style={{
            padding: "0.75rem 1.5rem",
            backgroundColor: isSubmitting || isRunning ? "#9ca3af" : "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: "0.5rem",
            cursor: isSubmitting || isRunning ? "not-allowed" : "pointer",
            fontWeight: "bold",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
