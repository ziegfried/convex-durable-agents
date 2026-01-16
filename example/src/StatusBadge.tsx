/**
 * Status badge component
 */
export function StatusBadge({ status }: { status: string }) {
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
