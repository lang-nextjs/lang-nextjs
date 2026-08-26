/**
 * Resolving a browser-openable console for an observability integration.
 *
 * In its own module rather than inside the route, because the interesting
 * behaviour is a REFUSAL and refusals are exactly what an end-to-end test
 * cannot reach here: the route reads /api/config server-to-server, so a
 * browser-level mock never sees it. Kept here, the rule is directly testable.
 */

/**
 * Where a PERSON would open this integration, as opposed to where the backend
 * posts spans to.
 *
 * THESE ARE DIFFERENT ADDRESSES AND THE LOCAL FIXTURE PROVES IT.
 * scripts/langfuse-local/backend-override.yml sets
 * `LANGFUSE_HOST: http://langfuse:3000` and says, one line above it: "the
 * in-network address, not localhost:3100". A link built from that host renders
 * a control that looks live and cannot resolve in any browser.
 *
 * So: link only an address a browser can plausibly reach, and say why when we
 * decline. This is the same refusal RunDeparture already makes for a rung with
 * no target — a dead button is worse than an honest absence.
 *
 * THE HEURISTIC AND ITS LIMIT, stated rather than buried: a hostname with no
 * dot that is not localhost is a container alias on a private network, which is
 * true of every docker-compose service name and is the case this exists to
 * catch. It is NOT true of a single-label intranet host a corporate DNS would
 * resolve; such a deployment gets no link and must set LANGFUSE_CONSOLE_URL.
 * Declining to link something reachable is the safe direction. Offering a link
 * that cannot resolve is not.
 */
export function browserReachable(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.includes("."))
    return u.origin;
  return null;
}

/** The console for one observability integration, or a reason there is none. */
export function consoleFor(
  id: string,
  host: string | null | undefined
): { consoleUrl?: string; consoleUnavailableBecause?: string } {
  if (id === "langsmith") {
    // LangSmith is hosted; its console address is not deployment-dependent.
    return { consoleUrl: "https://smith.langchain.com" };
  }
  if (id === "langfuse") {
    const explicit = browserReachable(process.env.LANGFUSE_CONSOLE_URL);
    if (explicit) return { consoleUrl: explicit };
    const reported = browserReachable(host);
    if (reported) return { consoleUrl: reported };
    return {
      consoleUnavailableBecause: host
        ? `the backend sends spans to ${host}, which is not an address this browser can open — set LANGFUSE_CONSOLE_URL to the public one`
        : "no host was reported, so there is no console address to offer",
    };
  }
  return {};
}
