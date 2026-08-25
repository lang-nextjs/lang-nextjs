"use client";

import Link from "next/link";
import { FRAMEWORKS } from "../lib/frameworks";

/**
 * The home page of a fork that has no run-shaped rung.
 *
 * WHY THIS EXISTS. Before #154, `/` WAS the kanban. After the split, a rung-1/2/3 fork keeps
 * the shell and /chat but has no run surface — so the front door had to become something.
 * The options were an empty board, a redirect, or this.
 *
 * An empty board is the worst of them: five columns with "none" under each, describing work
 * a fork structurally cannot have. It reads as broken rather than as absent, which is the
 * impression this whole milestone exists to remove.
 *
 * A bare redirect to /chat is defensible and I nearly did it — but the fork's front door is
 * the first thing a forker sees, and bouncing them somewhere without saying why teaches them
 * nothing about what they forked. This says what the fork is and offers the frameworks it
 * actually has.
 *
 * EVERYTHING HERE IS DERIVED. `FRAMEWORKS` comes from rungs.json via lib/frameworks.ts,
 * already sorted by ordinal (simple to complex, which is the ladder's own order). A fork
 * that ejected to rung 1 shows one entry; nothing here lists framework names, so nothing
 * here can disagree with the manifest.
 */
export function ConversationLanding() {
  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6" data-testid="conversation-landing">
      <div className="flex flex-col gap-2">
        <h1 className="text-foreground text-lg font-semibold tracking-tight">
          Start a conversation
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          This build has no run surface — it ships the conversation rungs of the
          ladder. Pick a framework to open the chat surface it serves.
        </p>
      </div>

      <ul
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="landing-frameworks"
      >
        {FRAMEWORKS.map((f) => (
          <li key={f.id}>
            <Link
              href={`/chat?framework=${encodeURIComponent(f.id)}`}
              data-testid="landing-framework-link"
              data-framework={f.id}
              className="border-border bg-card/60 hover:border-foreground/30 flex flex-col gap-1 rounded-xl border p-4 transition-colors"
            >
              <span className="text-foreground text-sm font-medium">
                {f.label}
              </span>
              <span className="text-muted-foreground text-xs">
                Open /chat on {f.label}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {/*
       * A fork with no conversation rung either cannot exist today — rung 1 is
       * retained by every eject, because the retain set is the target plus its
       * `requires` closure downward. Rendering a line rather than nothing keeps
       * the page from being empty if that ever stops being true.
       */}
      {FRAMEWORKS.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="landing-empty">
          This build declares no conversation rung.
        </p>
      ) : null}
    </div>
  );
}
