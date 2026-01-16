/**
 * Thread sidebar component
 */
export function ThreadSidebar({
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
      data-testid="thread-sidebar"
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
              color: currentThreadId === thread._id ? "#000" : "inherit",
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
