import { assertNever } from "@deepagents-nextjs/rungs";

/**
 * Dependency status — what a probe OBSERVED, never what config implies.
 *
 * #126: the panel reported `cfg?.activeLlm ? "configured" : "runs will fail"`.
 * A key being present says what was REQUESTED; only a live call says what
 * ANSWERS. A proxy verdict is worse than no verdict in one specific way: it
 * moves and looks responsive, so it earns trust a static string never would.
 *
 * FIVE STATES. The PO ruled four for liveness; `not-wired` is the fifth and is
 * a different axis — build-time capability, not runtime state.
 *
 *   not-configured  no credential/URL present. Actionable: tells you what to set.
 *   unverified      configured, NEVER PROBED. "Set up, never verified."
 *   unreachable     configured, probe ATTEMPTED AND FAILED. Something is broken.
 *   responding      a live probe succeeded, with latency.
 *   not-wired       this build does not integrate it. NOT a failure, never red.
 *
 * `unverified` vs `unreachable` is the distinction the PO added to my brief, and
 * it is load-bearing: the first may just need triggering, the second means
 * something is broken. Collapsing them loses what tells an operator what to do.
 */
export type DependencyState =
  | "not-configured"
  | "unverified"
  | "unreachable"
  | "responding"
  | "not-wired";

export type Tone = "success" | "destructive" | "muted" | "info";

export interface DependencyReport {
  id: string;
  label: string;
  state: DependencyState;
  /** What answered, or why it did not. */
  detail?: string;
  /** Round-trip of the successful probe. Absent unless `responding`. */
  latencyMs?: number;
  /** When this was observed. Absent when never probed. */
  probedAt?: string;
  /**
   * Why this dependency cannot be probed without a side effect, when that is
   * the reason it is `unverified`. Surfacing the cost rather than absorbing it.
   */
  unverifiableBecause?: string;
  /**
   * A browser-openable console for this dependency, when one is known.
   *
   * DELIBERATELY SEPARATE FROM THE HOST THE BACKEND SENDS TO. For Langfuse
   * those are routinely different, and the local fixture says so in its own
   * override file: "LANGFUSE_HOST is the in-network address, not
   * localhost:3100". Linking a person's browser at an in-network docker name
   * produces a control that looks live and cannot work — the failure this
   * codebase already refuses in RunDeparture, where a rung with no target
   * renders a refusal rather than a dead button.
   *
   * Absent means "we do not know where a human would open this", which is a
   * different statement from "there is nothing there".
   */
  consoleUrl?: string;
  /** Why no `consoleUrl` is offered, when the dependency is otherwise healthy. */
  consoleUnavailableBecause?: string;
}

/**
 * EXHAUSTIVE BY CONSTRUCTION. The previous colour switch ended in
 * `ELSE -> success`, so a sixth state would have rendered healthy — defused by
 * accident, not by design. `assertNever` makes a new state a COMPILE error
 * instead, and it is imported from packages/rungs rather than re-declared, so
 * this is the pattern carried to a new call site rather than reinvented.
 */
export function describeDependency(state: DependencyState): {
  tone: Tone;
  label: string;
} {
  switch (state) {
    case "responding":
      return { tone: "success", label: "responding" };
    case "unreachable":
      // Configured and failing — the state a boolean hides and the one people hit.
      return { tone: "destructive", label: "not responding" };
    case "not-configured":
      return { tone: "muted", label: "not configured" };
    case "unverified":
      // NOT green. Configuration is not observation.
      return { tone: "muted", label: "configured, not verified" };
    case "not-wired":
      // A capability that does not exist is not a failure. Never red: false
      // alarms are how operators learn to stop reading a panel.
      return { tone: "muted", label: "not wired in this build" };
    default:
      return assertNever(state);
  }
}

/** Only a live observation may claim health. */
export function isVerifiedHealthy(r: DependencyReport): boolean {
  return r.state === "responding";
}

/**
 * Age of an observation, in words.
 *
 * A green that was true 40 minutes ago is a different claim from a green
 * measured now, and a panel that cannot tell them apart is this same defect one
 * level up. `null` renders as "never probed" rather than as a fresh reading.
 */
export function formatAge(probedAt: string | undefined, now: number): string {
  if (!probedAt) return "never probed";
  const ms = now - Date.parse(probedAt);
  if (!Number.isFinite(ms) || ms < 0) return "age unknown";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * Tone -> the indicator dot's class. Exhaustive for the same reason `describeDependency` is.
 *
 * This is the LAST place a colour is decided, so it is the last place a default branch could
 * reintroduce the bug. It lives here rather than in a component because two surfaces now need
 * it — the settings dependency rows and the chat readiness dot — and a second copy is how one
 * of them ends up with a fall-through the other does not have.
 */
export function toneDotClass(tone: Tone): string {
  switch (tone) {
    case "success":
      return "bg-success";
    case "destructive":
      return "bg-destructive";
    case "info":
      return "bg-info";
    case "muted":
      return "bg-muted-foreground";
    default:
      return assertNever(tone);
  }
}

/**
 * WHAT THE DEPENDENCY PANEL KNOWS, AS THREE STATES RATHER THAN TWO (#237).
 *
 * The panel held `DependencyReport[] | null`, and `null` already meant "still
 * probing". A failed probe had nowhere to go, so `loadDeps` put it in `[]` —
 * which the panel renders as no rows and no message at all. A 500 and a
 * successful probe that found nothing produced the same empty box.
 *
 * This is the same shape as #246 one directory over: a type with no word for a
 * state the code can reach, so the code is forced to file it under something
 * that means otherwise. Naming the third state is the fix; the parsing below
 * is just what fills it in.
 */
export type DependencyProbe =
  | { kind: "probing" }
  | { kind: "ok"; rows: DependencyReport[]; probedAt?: string }
  | { kind: "failed"; message: string };

/**
 * READ THE RESPONSE, INCLUDING WHETHER IT SUCCEEDED (#237).
 *
 * `loadDeps` did `const b = (await r.json())` and never looked at `r.ok`, so a
 * 500 carrying `{"error": "..."}` fell through `b.dependencies ?? []` and was
 * rendered as a clean, empty panel. The one thing a person consults this panel
 * to learn — whether the probe worked — was the thing it could not report.
 */
export async function readDependencyProbe(
  res: Response
): Promise<DependencyProbe> {
  const raw = await res.text().catch(() => "");
  let body: { probedAt?: string; dependencies?: unknown; error?: unknown } = {};
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

  // A 200 that is not JSON, or whose `dependencies` is not a list, is not a
  // successful empty probe either — it is a response we cannot read. Reporting
  // it as "no dependencies" would be the same lie in a different colour.
  if (!parsed) {
    return {
      kind: "failed",
      message: withStatus(res.status, "the response was not JSON"),
    };
  }
  if (!Array.isArray(body.dependencies)) {
    return {
      kind: "failed",
      message: withStatus(
        res.status,
        `expected a list of dependencies, got ${typeof body.dependencies}`
      ),
    };
  }

  return {
    kind: "ok",
    rows: body.dependencies as DependencyReport[],
    probedAt: typeof body.probedAt === "string" ? body.probedAt : undefined,
  };
}

/** Clipped: upstream text goes straight into the panel, and can be an HTML page. */
function withStatus(status: number, detail: string): string {
  if (!detail) return `the probe failed with ${status}`;
  const clipped = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return `${status} — ${clipped}`;
}
