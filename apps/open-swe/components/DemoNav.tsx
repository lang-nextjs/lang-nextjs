"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Top-level demo switcher for the Lang-Next.js app. Two interaction modes,
 * one app, one origin:
 *   • Chat  — live chat against LangGraph / LangChain / DeepAgents (/chat)
 *   • Queue — OpenSWE batch/async run dashboard (/)
 */
export function DemoNav() {
  const pathname = usePathname();
  const active: "chat" | "queue" = pathname?.startsWith("/chat")
    ? "chat"
    : "queue";

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
        Lang-Next.js
      </span>
      <Link href="/chat" className={tab(active === "chat")}>
        💬 Live Chat
      </Link>
      <Link href="/" className={tab(active === "queue")}>
        ⚙ Queue · OpenSWE
      </Link>
      <span className="ml-auto text-[11px] text-neutral-400">
        {active === "chat"
          ? "LangGraph · LangChain · DeepAgents"
          : "batch / async runs"}
      </span>
    </nav>
  );
}
