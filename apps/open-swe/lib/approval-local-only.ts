import type { NextRequest } from "next/server";

/**
 * WHO MAY RESOLVE A PENDING APPROVAL (#160 gap 1).
 *
 * apps/example mounts these routes with no authorize callback and a comment
 * saying "no authorize callback in this demo (fail-open)". That sentence is
 * TRUE IN example — a transport demo, permanently, per #154 phase 3 — and FALSE
 * the moment it moves here. open-swe reaches real backends with a real key, and
 * every fork inherits it. Copying the six lines would give it an
 * unauthenticated endpoint where anyone who can reach the route approves any
 * pending action, and by our own policy those actions are the MUTATING ones.
 *
 * That would be strictly worse than the dead control #162 replaced. Today the
 * gate is absent and the UI admits it; a fail-open gate is absent AND asserted.
 *
 * WHAT THIS IS. An explicit refusal of anything non-local. The route is trusted
 * only from a loopback host, and only when the request's Origin — if it sends
 * one — matches its Host.
 *
 * WHAT THIS IS NOT, stated plainly so nobody reads more into it than it does:
 * this is NOT authentication. It does not separate two people sharing a
 * machine, and it does not survive the app being deployed anywhere real. It
 * stops a page on the internet from POSTing approvals on the user's behalf, and
 * it stops the endpoint being reachable from another host. That is the whole of
 * it.
 *
 * WHY NOT BIND TO A SESSION, which would be the real answer: open-swe has no
 * per-user identity to bind to. `sessionId` in the chat page is the hardcoded
 * literal "lang-nextjs-chat" — the same value for every user and every browser,
 * so a check against it passes for everyone, which is worse than no check
 * because it reads like one. And `PendingApproval` carries no owner field, so
 * there is nothing on the record to compare against even if there were an
 * identity. Making that possible means adding an owner to PendingApproval and
 * threading it through the gating transform — a packages/server change
 * inherited by every rung, filed as a follow-up rather than smuggled into a
 * feature PR.
 *
 * The difference between "no authorize callback" and "an authorize callback
 * that refuses anything non-local" is the point: both are limited, only the
 * second is a decision.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Strip the port and normalise, so `localhost:3001` matches `localhost`. */
function hostnameOf(value: string | null): string | null {
  if (!value) return null;
  const bare = value.replace(/^https?:\/\//, "");
  // IPv6 literals keep their brackets; everything else splits on the last colon.
  if (bare.startsWith("[")) return bare.slice(0, bare.indexOf("]") + 1);
  const i = bare.lastIndexOf(":");
  return (i === -1 ? bare : bare.slice(0, i)).toLowerCase();
}

/**
 * True when this request may resolve an approval.
 *
 * Both conditions must hold:
 *   1. the Host is a loopback address — the endpoint is not reachable as a
 *      service from elsewhere
 *   2. if an Origin is present, its host matches the Host — a cross-site page
 *      cannot drive it, even from the same machine
 *
 * A missing Origin is allowed: same-origin non-CORS requests and server-side
 * callers legitimately omit it, and rejecting those would break the app's own
 * fetch while stopping nothing a browser would send cross-site anyway.
 */
export function isLocalOnlyRequest(request: NextRequest): boolean {
  const host = hostnameOf(request.headers.get("host"));
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return hostnameOf(origin) === host;
}
