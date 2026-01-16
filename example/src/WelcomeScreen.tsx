/**
 * Welcome screen when no thread is selected and not starting a new chat
 */
export function WelcomeScreen({ onNewThread }: { onNewThread: () => void }) {
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
