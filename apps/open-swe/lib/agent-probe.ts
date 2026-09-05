/**
 * WHERE TO ASK A RUN BACKEND WHETHER IT IS ALIVE.
 *
 * `/ok` is the LangGraph Platform convention and is correct for a hosted
 * deployment. The local queue agent this repo starts serves `/health` and
 * returns 404 for `/ok` — so probing only `/ok` reported a perfectly healthy
 * agent as "not responding", having received an answer in 18ms.
 *
 * A 404 IS NOT A HEALTH SIGNAL. It means something is listening and does not
 * know that path, which is a fact about the PROBE, not about the service. Every
 * other status is: a 500 says it is unwell, a timeout says it is gone. So a 404
 * — and only a 404 — advances to the next candidate path.
 *
 * Ordered, not raced: a hosted platform must not be judged by whatever answers
 * first, and the list is short enough that sequential cost is one extra
 * round-trip in the local case.
 */
export const AGENT_PROBE_PATHS = ["/ok", "/health"] as const;

export interface ProbeAttempt {
  path: string;
  status?: number;
  error?: string;
  ms: number;
}

export interface ProbeOutcome {
  /** The attempt that decided the verdict. */
  decisive: ProbeAttempt;
  /** Every attempt made, so a report can say what was tried. */
  attempts: ProbeAttempt[];
  reachable: boolean;
  healthy: boolean;
}

/**
 * Try each candidate path until one gives a verdict.
 *
 * `healthy` and `reachable` are separate answers because they are separate
 * questions, and conflating them is what produced the original bug: a service
 * that answers is reachable whatever it answers, while only a 2xx says it is
 * well. A caller with no vocabulary for "reachable but unwell" should at least
 * be told which one it is looking at.
 */
export async function probeAgentPaths(
  baseUrl: string,
  fetchPath: (
    url: string
  ) => Promise<{ status?: number; error?: string; ms: number }>
): Promise<ProbeOutcome> {
  const root = baseUrl.replace(/\/$/, "");
  const attempts: ProbeAttempt[] = [];
  for (const path of AGENT_PROBE_PATHS) {
    const r = await fetchPath(`${root}${path}`);
    const attempt: ProbeAttempt = { path, ...r };
    attempts.push(attempt);
    if (r.error !== undefined) {
      // No answer at all. Trying another path cannot help — the next request
      // goes to the same host and will fail the same way.
      return { decisive: attempt, attempts, reachable: false, healthy: false };
    }
    if (r.status === 404) continue; // wrong path for THIS backend; keep looking
    return {
      decisive: attempt,
      attempts,
      reachable: true,
      healthy: r.status !== undefined && r.status >= 200 && r.status < 300,
    };
  }
  // Everything answered 404: something is listening and none of the paths we
  // know are its. Reachable, and we cannot say it is well.
  const last = attempts[attempts.length - 1];
  return { decisive: last, attempts, reachable: true, healthy: false };
}
