import { withStatus } from "./dependency-status";

/**
 * WHETHER THIS BUILD HAS A SANDBOX, AND WHETHER IT IS WORKING (#337).
 *
 * These are two different questions and the settings panel could answer
 * neither. It did:
 *
 *     .then(async (r) => ({ ok: r.ok, body: (await r.json()) as Health }))
 *     .then(({ body }) => setHealth(body))
 *
 * `ok` was computed on one line and dropped on the next.
 *
 * WHAT KEPT THAT FROM SHOWING was an accident, not a check. Next answers a
 * missing route with an HTML error page, so `r.json()` threw and the `.catch`
 * wrote a parse-error message — which reads like handling. A route answering
 * `404 {"error": "..."}` parses fine, so the error payload was stored AS the
 * health object and the panel rendered a red dot beside the word "unknown":
 * clean, confident, and wrong. Same shape as #237 one panel over, where a 500
 * fell through `?? []` and rendered as a successful empty probe.
 *
 * ABSENT IS NOT BROKEN, and this is why the union has four members rather than
 * three. After `pnpm eject langchain` the settings page survives — it is
 * `shared` since #154 — while `/api/open-swe/*` does not. That fork is CORRECT
 * and its sandbox probe 404s forever. Reporting it in the same red as a dead
 * Docker daemon would have every rung-1 fork shipping with a permanent fault
 * light for a component it was never supposed to contain.
 *
 * Modelled on readDependencyProbe in ./dependency-status, deliberately: the
 * sibling panel already learned this lesson and the two should fail the same
 * way rather than each inventing a vocabulary.
 */
export type SandboxProbe =
  /** The route is not in this build. A correct state for a fork, not a fault. */
  | { kind: "absent" }
  /** The route answered and we could read it. `available` is the sandbox's own verdict. */
  | { kind: "ok"; provider?: string; available: boolean; detail?: string }
  /** The route is there and something went wrong — including a 200 we cannot read. */
  | { kind: "failed"; message: string };

export async function readSandboxHealth(res: Response): Promise<SandboxProbe> {
  // 404 IS CHECKED BEFORE THE BODY IS PARSED, which is the whole fix. Both the
  // HTML page Next serves and a JSON `{"error": ...}` must reach the same
  // answer; deciding on the body is what made the two differ.
  if (res.status === 404) return { kind: "absent" };

  const raw = await res.text().catch(() => "");
  let body: {
    provider?: unknown;
    available?: unknown;
    detail?: unknown;
    error?: unknown;
  } = {};
  let parsed = false;
  try {
    body = JSON.parse(raw) as typeof body;
    parsed = true;
  } catch {
    // Left as {} — handled below, differently depending on res.ok.
  }

  if (!res.ok) {
    const said =
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : raw.trim();
    return { kind: "failed", message: withStatus(res.status, said) };
  }

  // A 200 we cannot read is not a healthy sandbox. Defaulting `available` to
  // false here would render "unavailable" — a claim about the sandbox we have
  // no evidence for — when the truth is that we could not tell.
  if (!parsed) {
    return {
      kind: "failed",
      message: withStatus(res.status, "the response was not JSON"),
    };
  }

  return {
    kind: "ok",
    provider: typeof body.provider === "string" ? body.provider : undefined,
    // Absent `available` reads as false: the endpoint's contract is to say so
    // when it is up, and silence is not a yes.
    available: body.available === true,
    detail: typeof body.detail === "string" ? body.detail : undefined,
  };
}

/** What the probe could not reach at all — a rejected fetch, not a response. */
export function sandboxUnreachable(e: unknown): SandboxProbe {
  return {
    kind: "failed",
    message: e instanceof Error ? e.message : String(e),
  };
}
