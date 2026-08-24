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
        ? "bg-neutral-100 text-neutral-900"
        : "text-neutral-400 hover:text-neutral-100"
    }`;

  return (
    <nav className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-800 bg-[#0a0a0b] px-5 py-2.5">
      <span className="mr-2 flex items-center gap-2 text-sm font-semibold text-neutral-100">
        <span className="grid h-5 w-5 place-items-center rounded bg-neutral-100 text-[11px] font-bold text-neutral-900">
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
        Contrast floor: this caption sits on the nav's #0a0a0b bar at 11px
        (normal weight), so WCAG AA demands 4.5:1. neutral-600 (#525252) was
        2.53:1 and failed axe on every route that renders the layout.
        neutral-500 (#737373) is still only 4.17:1 — the first palette step
        that clears the bar is neutral-400 at 7.66:1. Do not darken this
        below neutral-400 without re-checking the ratio.
      */}
      <span className="ml-auto text-[11px] text-neutral-400">
        {active === "chat"
          ? "LangGraph · LangChain · DeepAgents"
          : "batch / async runs"}
      </span>
    </nav>
  );
}
