import { useDeepAgentsChat } from "@deepagents-nextjs/remix";

export default function ChatPage() {
  const { messages, status, start } = useDeepAgentsChat("/api/chat/stream", {
    sessionId: "remix-1",
  });

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "1rem" }}>
      <h1
        style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}
      >
        DeepAgents Remix Example
      </h1>

      <div
        style={{
          minHeight: 200,
          border: "1px solid #e5e7eb",
          borderRadius: "0.5rem",
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: "#9ca3af", fontSize: "0.875rem" }}>
            Click Start to stream a response.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: "0.5rem", fontSize: "0.875rem" }}>
            <strong>{(msg as { type?: string }).type ?? "message"}:</strong>{" "}
            {(msg as { content?: string }).content ?? JSON.stringify(msg)}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          onClick={start}
          disabled={status !== "idle"}
          style={{
            padding: "0.5rem 1rem",
            background: "#2563eb",
            color: "white",
            border: "none",
            borderRadius: "0.375rem",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          Start
        </button>
        <span
          data-testid="status"
          style={{ fontSize: "0.75rem", color: "#6b7280" }}
        >
          {status}
        </span>
      </div>
    </main>
  );
}
