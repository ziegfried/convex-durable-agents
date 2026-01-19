import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";

/**
 * New chat screen - shows input to start a new conversation
 * Thread is only created when the first message is sent
 */
export function NewChatScreen({ onThreadCreated }: { onThreadCreated: (threadId: string) => void }) {
  const createThread = useMutation(api.chat.createThread);
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const suggestions = [
    "What's the weather in San Francisco?",
    "Tell me about the weather in Tokyo",
    "Compare the weather in New York and London",
  ];

  const handleSubmit = async (prompt: string) => {
    if (!prompt.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const threadId = await createThread({ prompt: prompt.trim() });
      onThreadCreated(threadId);
    } catch (error) {
      console.error("Failed to create thread:", error);
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handleSubmit(input);
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ marginBottom: "1rem" }}>🤖 Durable Agents Demo</h1>
      <p style={{ color: "#6b7280", marginBottom: "2rem", textAlign: "center", maxWidth: "400px" }}>
        This example demonstrates the Convex Durable Agents component with tool execution, streaming responses, and
        crash recovery.
      </p>

      {/* Suggestions */}
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1.5rem", justifyContent: "center" }}
      >
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleSubmit(suggestion)}
            style={{
              padding: "0.5rem 1rem",
              backgroundColor: "transparent",
              border: "1px solid #e5e7eb",
              borderRadius: "9999px",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              fontSize: "0.875rem",
              color: "#6b7280",
              opacity: isSubmitting ? 0.5 : 1,
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* Input */}
      <form
        onSubmit={handleFormSubmit}
        style={{
          width: "100%",
          maxWidth: "600px",
          display: "flex",
          gap: "0.5rem",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message AI assistant..."
          disabled={isSubmitting}
          style={{
            flex: 1,
            padding: "0.75rem 1rem",
            border: "1px solid #e5e7eb",
            borderRadius: "0.5rem",
            fontSize: "1rem",
          }}
        />
        <button
          type="submit"
          disabled={isSubmitting || !input.trim()}
          style={{
            padding: "0.75rem 1.5rem",
            backgroundColor: isSubmitting ? "#9ca3af" : "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: "0.5rem",
            cursor: isSubmitting || !input.trim() ? "not-allowed" : "pointer",
            fontWeight: "bold",
          }}
        >
          {isSubmitting ? "Starting..." : "Send"}
        </button>
      </form>
    </div>
  );
}
