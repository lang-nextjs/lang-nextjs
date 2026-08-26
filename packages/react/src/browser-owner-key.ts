/**
 * A per-browser owner key for approval gating (#170).
 *
 * WHY A FRESH SECRET RATHER THAN AN ID THE APP ALREADY HAS. The obvious candidate was the
 * conversation/session id already threaded to the backend. Measured against the tree, neither
 * existing value can carry this job:
 *
 *   apps/open-swe   `sessionId: "lang-nextjs-chat"` — a HARDCODED constant, identical in every
 *                   browser. Owner-matching against it is a no-op that LOOKS like a guard.
 *   apps/example    `hitl-${Date.now()}` — described here as "per-tab", which it was not:
 *                   millisecond resolution means two tabs mounting in the same millisecond
 *                   shared one id. Guessability was the weaker of its two problems; the
 *                   COLLISION was a correctness one. Now newSessionId() (#114) — but the
 *                   conclusion is unchanged, because a session id is still the wrong bearer.
 *
 * And an id that is already threaded is already logged: making a conversation id the bearer
 * token widens the capability every time anything writes a conversation id to a log, a URL, or
 * an error report. This value is never sent anywhere except the two headers that need it.
 *
 * WHY localStorage AND NOT sessionStorage. The boundary we want is BETWEEN BROWSERS, not
 * between tabs — the defect is that one visitor's approvals sit in the same process-global
 * registry as another's. localStorage is shared across tabs of one origin, so a person can
 * approve from a second tab, which is the behaviour you want. sessionStorage would be stricter
 * than the threat and would break that.
 *
 * WHAT THIS IS NOT: authentication. It is a second bearer token — see the security-model block
 * in packages/server/src/approval-routes.ts. It narrows "anyone holding the approvalId" to
 * "anyone holding the id AND this browser's key". It identifies nobody.
 */

const STORAGE_KEY = "deepagents:approval-owner:v1";

/**
 * Returns this browser's stable approval owner key, minting one on first use.
 *
 * Returns `undefined` when there is no browser storage — during SSR, or when storage is
 * unavailable (private mode, disabled cookies, a sandboxed iframe). That is deliberate:
 * approvals then carry no owner and stay resolvable by id alone, which is the documented
 * pre-#170 behaviour rather than a hard failure. A gate that stops working because storage is
 * disabled would be worse than one that degrades to its previous contract.
 */
export function getBrowserOwnerKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, minted);
    return minted;
  } catch {
    // Storage unavailable or quota-exceeded — degrade to no owner, as above.
    return undefined;
  }
}

/** The storage key, exported so a consumer can clear it (e.g. a "sign out of this browser"). */
export const APPROVAL_OWNER_STORAGE_KEY = STORAGE_KEY;
