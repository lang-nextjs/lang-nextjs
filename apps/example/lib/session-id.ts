/**
 * A FRESH SESSION ID PER MOUNT — AND "FRESH" HAS TO MEAN IT (#114).
 *
 * This was `hitl-${Date.now()}`, written inline in the demo page. Date.now()
 * has millisecond resolution, so two pages that mount within the same
 * millisecond receive the SAME id. That is not a remote possibility: the e2e
 * suite opens two tabs with
 *
 *   await Promise.all([tabA.goto("/hitl-demo"), tabB.goto("/hitl-demo")]);
 *
 * and a person opening two tabs from a bookmark bar does the same thing more
 * slowly. Both sessions then post to one id, and their approvals land in one
 * entry of a registry keyed by that id.
 *
 * browser-owner-key.ts described this value as "per-tab but timestamp-derived,
 * so guessable inside a window" — which named the weaker of the two problems.
 * Guessability is a security property. THE COLLISION IS A CORRECTNESS ONE, and
 * a timestamp cannot be an identity no matter how it is compared.
 *
 * crypto.randomUUID is what the same package already uses to mint the approval
 * owner key, one file over. This is the same decision, applied consistently.
 */
export function newSessionId(prefix = "hitl"): string {
  return `${prefix}-${randomToken()}`;
}

/**
 * The fallback exists for the same reason getBrowserOwnerKey's does: this must
 * degrade rather than throw. `crypto.randomUUID` needs a secure context, so it
 * is absent over plain http on a LAN address — which is exactly how someone
 * demoing this on a phone reaches it (`next dev -H 0.0.0.0`).
 *
 * getRandomValues survives that case and is still a real 128 bits. Only if both
 * are gone does this fall back to time, and then it says so in the value: an id
 * that collides is much easier to diagnose when it is labelled `weak` than when
 * it is indistinguishable from a good one.
 */
function randomToken(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `weak-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 0xffffffff
  ).toString(36)}`;
}
