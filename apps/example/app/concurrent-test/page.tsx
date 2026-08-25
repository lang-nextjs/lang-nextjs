"use client";

/**
 * Test harness for two parallel useDeepAgentsChat hooks in the same React tree.
 *
 * Used by e2e/nextjs-extra.spec.ts ("concurrent runs in single React tree")
 * to prove that two chat sessions mounted in the same tree don't cross-
 * contaminate each other's messages or state.
 *
 * Each pane uses a distinct sessionId; the e2e spec mocks /api/chat/stream
 * to branch on the sessionId in the POST body so the two hooks receive
 * different responses concurrently.
 */

import { useState } from "react";
import { useDeepAgentsChat } from "@deepagents-nextjs/react";

function ChatPane({
  paneId,
  sessionId,
}: {
  paneId: "a" | "b";
  sessionId: string;
}) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useDeepAgentsChat({
    sessionId,
    endpoint: "/api/chat/stream",
  });

  return (
    <section
      data-testid={`pane-${paneId}`}
      data-session-id={sessionId}
      style={{
        border: "1px solid #d1d5db",
        borderRadius: 8,
        padding: "0.75rem",
        margin: "0.5rem",
      }}
    >
      <h2>Pane {paneId.toUpperCase()}</h2>
      <p data-testid={`pane-${paneId}-status`}>{status}</p>
      <div data-testid={`pane-${paneId}-messages`}>
        {messages.map((m, i) => (
          <div
            key={i}
            data-testid={`pane-${paneId}-message`}
            data-role={(m as { type?: string }).type}
          >
            {(m as { content?: string }).content ?? JSON.stringify(m)}
          </div>
        ))}
      </div>
      <input
        data-testid={`pane-${paneId}-input`}
        aria-label={`Pane ${paneId.toUpperCase()} message input`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <button
        data-testid={`pane-${paneId}-send`}
        disabled={
          !input.trim() || status === "streaming" || status === "submitted"
        }
        onClick={() => {
          sendMessage(input);
          setInput("");
        }}
      >
        Send
      </button>
    </section>
  );
}

export default function ConcurrentTestPage() {
  return (
    <div data-testid="concurrent-test-page">
      <h1>Concurrent chat sessions</h1>
      <ChatPane paneId="a" sessionId="concurrent-session-a" />
      <ChatPane paneId="b" sessionId="concurrent-session-b" />
    </div>
  );
}
