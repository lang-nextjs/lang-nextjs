"use client";

import type { TranscriptRead } from "../lib/transcript";

/**
 * The saved transcript of a restored conversation (#122).
 *
 * THIS IS RENDERED AS A RECORD, NOT AS MESSAGES, AND THAT IS THE POINT. The
 * entries come from localStorage. The agent's memory of this session comes from
 * `sessionId` on the backend, and may be empty, expired, or served by a
 * different process. So what is on screen and what the agent actually has CAN
 * DIVERGE — and a person looking at their own history will reasonably assume
 * the agent remembers it.
 *
 * Making that structural rather than a footnote is why this is a bordered,
 * labelled block above the live conversation instead of more chat bubbles. A
 * sentence saying "this is only a record" under messages that look exactly like
 * live ones is a claim; a visibly separate section is the thing itself.
 *
 * It renders all THREE states, because "there were no messages" and "we could
 * not read them" are different facts and only one of them is good news:
 *   ok         -> the record, plus an eviction notice when anything was dropped
 *   empty      -> nothing at all (the caller decides whether to say so)
 *   unreadable -> says so, and never masquerades as an empty history
 */
export function ChatTranscriptRecord({ read }: { read: TranscriptRead }) {
  if (read.state === "empty") return null;

  if (read.state === "unreadable") {
    return (
      <section
        data-testid="transcript-record"
        data-transcript-state="unreadable"
        role="status"
        className="border-warning/30 bg-warning/10 mx-auto mb-4 w-full max-w-5xl rounded-lg border px-4 py-3"
      >
        <p className="text-warning text-sm font-medium">
          Saved history could not be read
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          There is a saved transcript for this conversation, but it could not be
          parsed — so it is not shown rather than shown as empty. This is a
          display problem only; nothing was sent to the agent either way.
        </p>
      </section>
    );
  }

  const { entries, evicted } = read.transcript;

  return (
    <section
      data-testid="transcript-record"
      data-transcript-state="ok"
      aria-label="Saved transcript"
      className="border-border bg-card/40 mx-auto mb-4 w-full max-w-5xl rounded-lg border px-4 py-3"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-foreground text-xs font-semibold uppercase tracking-wide">
          Saved record
        </p>
        <p
          data-testid="transcript-record-caveat"
          className="text-muted-foreground text-[11px]"
        >
          Stored in this browser. The agent may not have this context.
        </p>
      </div>

      {evicted && (
        <p
          data-testid="transcript-evicted"
          role="status"
          className="text-warning border-warning/30 bg-warning/10 mb-2 rounded border px-2 py-1 text-[11px]"
        >
          Earlier messages were dropped to stay within browser storage — this
          record starts mid-conversation.
        </p>
      )}

      <ol className="space-y-1">
        {entries.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            data-testid="transcript-entry"
            data-role={e.role}
            className="text-muted-foreground text-xs"
          >
            <span className="text-foreground font-mono text-[10px] uppercase">
              {e.role}
            </span>{" "}
            {e.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
