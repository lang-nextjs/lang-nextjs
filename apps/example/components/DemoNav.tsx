import Link from "next/link";

/**
 * Top-level demo switcher shared (by convention) across the two demo surfaces:
 *   • Chat  — live chat against LangGraph / LangChain / DeepAgents (this app)
 *   • Queue — OpenSWE batch/queue dashboard (the standalone open-swe app)
 *
 * The two run as separate apps/origins in dev, so the URLs are configurable via
 * NEXT_PUBLIC_CHAT_URL / NEXT_PUBLIC_QUEUE_URL (defaults target localhost).
 */
export function DemoNav({ active }: { active: "chat" | "queue" }) {
  const chatUrl = process.env.NEXT_PUBLIC_CHAT_URL ?? "http://localhost:3000";
  const queueUrl = process.env.NEXT_PUBLIC_QUEUE_URL ?? "http://localhost:3001";

  const tab = (isActive: boolean) =>
    `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <nav className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-sidebar px-5 py-2.5">
      <span className="mr-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="grid h-5 w-5 place-items-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
          ◇
        </span>
        DeepAgents
      </span>
      <Link href={chatUrl} className={tab(active === "chat")}>
        💬 Live Chat
      </Link>
      <Link href={queueUrl} className={tab(active === "queue")}>
        ⚙ Queue · OpenSWE
      </Link>
      {/*
        #24's caption. The hardcoded neutral-400 that fixed it is gone: colour
        now comes from the canonical theme, and redeclaring it locally is what
        df-theme-check exists to reject. muted-foreground measures 6.56:1 on
        --df-bg and 8.29:1 of headroom on the rail — verified with axe on the
        rendered page, not inferred from the token table.
      */}
      <span className="ml-auto text-[11px] text-muted-foreground">
        {active === "chat"
          ? "LangGraph · LangChain · DeepAgents"
          : "batch / async runs"}
      </span>
    </nav>
  );
}
