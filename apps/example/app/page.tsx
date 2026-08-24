import { ConversationSurface } from "@/components/ConversationSurface";

/**
 * `/` — the conversation surface, opened on this build's default rung.
 *
 * DELIBERATELY NOT A REDIRECT to /r/<default>. Forty `goto("/")` calls across thirteen spec
 * files land here, and e2e/matrix/matrix.spec.ts clicks a backend button and immediately
 * fills a textbox — a redirect (or a selector that navigates) remounts the surface mid-
 * sequence and breaks it. `/` stays a working surface; `/r/[rung]` seeds the same component
 * with a rung from the route and owns any URL writing.
 *
 * The surface itself moved to components/ConversationSurface.tsx so both routes mount one
 * component rather than two that drift.
 */
export default function ChatPage() {
  return <ConversationSurface />;
}
