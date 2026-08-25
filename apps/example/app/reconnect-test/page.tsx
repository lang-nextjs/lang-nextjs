"use client";
import { useState } from "react";
import { useDeepAgentsChat } from "@deepagents-nextjs/react";

export default function ReconnectTestPage() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, retry, status } = useDeepAgentsChat({
    sessionId: "reconnect-test",
    endpoint: "/api/chat/stream",
    enableReconnect: true,
    resumeId: "test-resume-id-123",
    resumeEndpoint: "/api/chat/stream/resume",
  });

  return (
    <div>
      <div data-testid="status">{status}</div>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <div key={i} data-role={(msg as any).type} data-testid="message">
            {(msg as any).content ?? JSON.stringify(msg)}
          </div>
        ))}
      </div>
      <input
        data-testid="input"
        aria-label="Reconnect harness message input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={status !== "idle"}
      />
      <button
        data-testid="send"
        disabled={status !== "idle" || !input.trim()}
        onClick={() => {
          sendMessage(input);
          setInput("");
        }}
      >
        Send
      </button>
      <button data-testid="retry" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
