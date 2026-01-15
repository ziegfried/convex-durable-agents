/* eslint-disable react-hooks/refs */
import "./App.css";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState, useRef, useEffect } from "react";
import { useThread, useSmoothText, type UIMessage } from "convex-durable-agents/react";

// ============================================================================
// Components
// ============================================================================

/**
 * Smooth text component for streaming messages
 */
function SmoothText({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const wasStreamingRef = useRef(isStreaming);
  if (isStreaming) {
    wasStreamingRef.current = true;
  }

  const [visibleText] = useSmoothText(text, {
    startStreaming: wasStreamingRef.current,
    charsPerSec: isStreaming ? 128 : 512,
  });

  return <span>{visibleText}</span>;
}

/**
 * Status badge component
 */
function StatusBadge({ status }: { status: string }) {
  const statusConfig: Record<string, { label: string; color: string }> = {
    streaming: { label: "Generating...", color: "#3b82f6" },
    awaiting_tool_results: { label: "Running tools...", color: "#f59e0b" },
    completed: { label: "Complete", color: "#22c55e" },
    failed: { label: "Failed", color: "#ef4444" },
    stopped: { label: "Stopped", color: "#6b7280" },
  };

  const config = statusConfig[status] || statusConfig.completed;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0.25rem 0.5rem",
        borderRadius: "9999px",
        fontSize: "0.75rem",
        backgroundColor: `${config.color}20`,
        color: config.color,
        border: `1px solid ${config.color}40`,
      }}
    >
      {(status === "streaming" || status === "awaiting_tool_results") && <span className="loading-dot" />}
      {config.label}
    </span>
  );
}

/**
 * Single chat message component
 */
function ChatMessage({ message }: { message: UIMessage }) {
  const isStreaming = message.status === "streaming" || message.status === "awaiting_tool_results";

  // Extract text content from parts
  const textContent = message.parts
    .filter((part): part is { type: "text"; text: string } => {
      return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
    })
    .map((part) => part.text)
    .join("");

  // Extract tool invocations
  const toolInvocations = message.parts.filter(
    (
      part,
    ): part is {
      type: "tool-invocation";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      state: string;
    } => {
      return typeof part === "object" && part !== null && (part as { type?: string }).type === "tool-invocation";
    },
  );

  // Extract standalone tool calls
  const toolCalls = message.parts.filter(
    (part): part is { type: "tool-call"; toolCallId: string; toolName: string; input: unknown } => {
      return typeof part === "object" && part !== null && (part as { type?: string }).type === "tool-call";
    },
  );

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
              {tc.state === "result" ? " ✓" : " ..."}
            </div>
            {tc.result !== undefined && (
              <pre style={{ margin: 0, fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
                {JSON.stringify(tc.result, null, 2)}
              </pre>
            )}
          </div>
        ))}

        {/* Standalone tool calls */}
        {toolCalls.map((tc) => (
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
            <div style={{ fontWeight: "bold" }}>🔧 Calling {tc.toolName}...</div>
          </div>
        ))}

        {/* Text content */}
        {textContent && (
          <div style={{ whiteSpace: "pre-wrap" }}>
            <SmoothText text={textContent} isStreaming={isStreaming} />
          </div>
        )}

        {/* Loading indicator */}
        {isStreaming && !textContent && toolCalls.length === 0 && toolInvocations.length === 0 && (
          <div style={{ color: "rgba(0,0,0,0.5)" }}>Thinking...</div>
        )}
      </div>
    </div>
  );
}

/**
 * Thread sidebar component
 */
function ThreadSidebar({
  threads,
  currentThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  threads: Array<{ _id: string; _creationTime: number; status: string }> | undefined;
  currentThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
}) {
  return (
    <div
      style={{
        width: "250px",
        borderRight: "1px solid #e5e7eb",
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <button
        onClick={onNewThread}
        style={{
          padding: "0.75rem",
          backgroundColor: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: "0.5rem",
          cursor: "pointer",
          marginBottom: "1rem",
          fontWeight: "bold",
        }}
      >
        + New Chat
      </button>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {threads?.length === 0 && (
          <div style={{ color: "#9ca3af", textAlign: "center", padding: "1rem" }}>No conversations yet</div>
        )}

        {threads?.map((thread) => (
          <div
            key={thread._id}
            onClick={() => onSelectThread(thread._id)}
            style={{
              padding: "0.75rem",
              borderRadius: "0.5rem",
              cursor: "pointer",
              backgroundColor: currentThreadId === thread._id ? "#e5e7eb" : "transparent",
              marginBottom: "0.25rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>Conversation</div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                {new Date(thread._creationTime).toLocaleDateString()}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm("Delete this conversation?")) {
                  onDeleteThread(thread._id);
                }
              }}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#9ca3af",
                fontSize: "1rem",
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Chat view component
 */
function ChatView({ threadId }: { threadId: string }) {
  const sendMessage = useMutation(api.chat.sendMessage);
  const stopThread = useMutation(api.chat.stopThread);
  const resumeThread = useMutation(api.chat.resumeThread);

  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use the durable agent hooks with streaming enabled
  const { messages, status, isLoading, isRunning, isFailed, isStopped } = useThread(
    api.chat.listMessagesWithStreams,
    api.chat.getThread,
    { threadId },
    { stream: true },
  );

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
      await stopThread({ threadId });
    } catch (error) {
      console.error("Failed to stop thread:", error);
    }
  };

  const handleRetry = async () => {
    try {
      await resumeThread({ threadId });
    } catch (error) {
      console.error("Failed to retry:", error);
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
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
          <ChatMessage key={message.key} message={message} />
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

/**
 * New chat screen - shows input to start a new conversation
 * Thread is only created when the first message is sent
 */
function NewChatScreen({ onThreadCreated }: { onThreadCreated: (threadId: string) => void }) {
  const createThread = useAction(api.chat.createThread);
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

/**
 * Welcome screen when no thread is selected and not starting a new chat
 */
function WelcomeScreen({ onNewThread }: { onNewThread: () => void }) {
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
      <button
        onClick={onNewThread}
        style={{
          padding: "1rem 2rem",
          backgroundColor: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: "0.5rem",
          cursor: "pointer",
          fontWeight: "bold",
          fontSize: "1rem",
        }}
      >
        Start a New Conversation
      </button>
      <div style={{ marginTop: "2rem", color: "#9ca3af", fontSize: "0.875rem" }}>
        <p>Try asking:</p>
        <ul style={{ textAlign: "left" }}>
          <li>"What's the weather in San Francisco?"</li>
          <li>"Tell me about the weather in Tokyo"</li>
          <li>"Compare the weather in New York and London"</li>
        </ul>
      </div>
    </div>
  );
}

// ============================================================================
// Main App
// ============================================================================

function App() {
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [isNewChat, setIsNewChat] = useState(false);
  const threads = useQuery(api.chat.listThreads, { limit: 50 });
  const deleteThread = useMutation(api.chat.deleteThread);

  const handleNewThread = () => {
    // Don't create thread yet, just show the new chat screen
    setCurrentThreadId(null);
    setIsNewChat(true);
  };

  const handleThreadCreated = (threadId: string) => {
    setCurrentThreadId(threadId);
    setIsNewChat(false);
  };

  const handleSelectThread = (threadId: string) => {
    setCurrentThreadId(threadId);
    setIsNewChat(false);
  };

  const handleDeleteThread = async (threadId: string) => {
    try {
      await deleteThread({ threadId });
      if (currentThreadId === threadId) {
        setCurrentThreadId(null);
      }
    } catch (error) {
      console.error("Failed to delete thread:", error);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <ThreadSidebar
        threads={threads}
        currentThreadId={currentThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onDeleteThread={handleDeleteThread}
      />
      {currentThreadId ? (
        <ChatView threadId={currentThreadId} />
      ) : isNewChat ? (
        <NewChatScreen onThreadCreated={handleThreadCreated} />
      ) : (
        <WelcomeScreen onNewThread={handleNewThread} />
      )}
    </div>
  );
}

export default App;
