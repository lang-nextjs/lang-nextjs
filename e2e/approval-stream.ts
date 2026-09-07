/**
 * READ AN SSE STREAM AND ANSWER THE APPROVALS IT RAISES, WHILE IT IS STILL OPEN (#887).
 *
 * WHY THIS CANNOT BE A SECOND REQUEST APPENDED TO A HELPER, which is the shape everyone
 * reaches for first — including the comment in live-transport.spec.ts that says a gated call
 * is "paused until someone answers it, on a LATER request".
 *
 * `approval-gating.ts` holds the proxy response open after upstream ends while an approval is
 * pending — `drainGraceMs`, default 30_000 — and its close-time sweep runs when that expires.
 * A decision must land INSIDE that window. Playwright's `request.post` resolves only once the
 * body is complete, i.e. once the stream has closed, i.e. AFTER the sweep has already fired
 * and emitted `tool_executed_without_approval`. By the time a caller can see the approval
 * frame through that API, the window it needed is gone.
 *
 * So the read has to be incremental. This uses `fetch` and a ReadableStream reader rather than
 * Playwright's APIRequestContext for that one reason, and for no other.
 *
 * WHAT IT DOES NOT DO. It does not decide whether answering is correct for a given test — a
 * suite that means to assert on the un-answered state should not call this. It answers every
 * approval it sees with one decision and records what it did, so a caller can assert on the
 * record rather than on the absence of an error frame.
 *
 * THE RECORD IS THE POINT. A test that fails here runs in a main-only job whose log is the
 * entire evidence, and re-running destroys the diagnosis. So every field a failure message
 * could need is returned rather than logged: what was sent, which approvals appeared, which
 * decisions were accepted, and the raw body. A bare `expect(...).toBe(...)` on top of this
 * still costs a re-run to interpret; a message built from the record does not.
 */

/** The decisions the approval route accepts. `approve` is the only one this helper sends today. */
export type ApprovalDecision = "approve" | "reject";

/** One approval this stream raised, and what became of it. */
export interface AnsweredApproval {
  id: string;
  actionName: string | null;
  /** HTTP status of the decision POST, or null if it threw before answering. */
  decisionStatus: number | null;
  /** The decision route's response body, truncated. Empty when the POST threw. */
  decisionBody: string;
  /** Set when the POST itself threw rather than returning a status. */
  error: string | null;
}

export interface StreamWithApprovalsResult {
  status: number;
  /** Every byte of the SSE body, accumulated as it arrived. */
  body: string;
  /** Approvals seen, in arrival order, each with the outcome of its decision. */
  approvals: AnsweredApproval[];
  /** True if the read ended because the deadline passed rather than because upstream closed. */
  timedOut: boolean;
}

/**
 * The approval id lives at `data.id` of a `data-approval-required` frame
 * (packages/server/src/approval-gating.ts:640-646). Parsed per line rather than by scanning
 * the accumulated body, because the whole point is to act before the body exists.
 */
function parseApprovalFrame(
  line: string
): { id: string; actionName: string | null } | null {
  if (!line.startsWith("data: ")) return null;
  let frame: unknown;
  try {
    frame = JSON.parse(line.slice(6));
  } catch {
    // A non-JSON data line is not an approval. Silently skipping is correct here and
    // nowhere else: the caller still receives every byte in `body` and can assert on it.
    return null;
  }
  const f = frame as {
    type?: unknown;
    data?: { id?: unknown; actionName?: unknown };
  };
  if (f?.type !== "data-approval-required") return null;
  const id = f?.data?.id;
  if (typeof id !== "string" || id === "") return null;
  return {
    id,
    actionName:
      typeof f.data?.actionName === "string" ? f.data.actionName : null,
  };
}

export async function streamAnsweringApprovals(opts: {
  /** Absolute URL of the streaming endpoint. Absolute because `fetch` has no baseURL. */
  url: string;
  /** Absolute URL for one approval id. */
  approvalUrl: (id: string) => string;
  payload: unknown;
  decision?: ApprovalDecision;
  headers?: Record<string, string>;
  /** Ceiling on the whole exchange, including the post-upstream drain. */
  timeoutMs?: number;
}): Promise<StreamWithApprovalsResult> {
  const decision = opts.decision ?? "approve";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 180_000);

  const approvals: AnsweredApproval[] = [];
  let body = "";

  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(opts.payload),
      signal: controller.signal,
    });

    if (!res.body) return { status: res.status, body: "", approvals, timedOut };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    /*
     * A frame can be split across chunk boundaries, so lines are only complete up to the last
     * newline. Holding the remainder is what stops a half-arrived approval frame being parsed
     * as malformed and skipped — which would look exactly like the model not having called a
     * tool, and is the failure this helper exists to prevent.
     */
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      body += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const found = parseApprovalFrame(line.trim());
        if (!found) continue;
        if (approvals.some((a) => a.id === found.id)) continue;
        const answered: AnsweredApproval = {
          id: found.id,
          actionName: found.actionName,
          decisionStatus: null,
          decisionBody: "",
          error: null,
        };
        approvals.push(answered);
        /*
         * AWAITED, NOT FIRED AND FORGOTTEN. The decision has to be accepted before the drain
         * grace expires, and an unawaited promise here would let the reader race ahead and the
         * stream close with the POST still in flight — reproducing the defect while appearing
         * to fix it.
         */
        try {
          const dec = await fetch(opts.approvalUrl(found.id), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(opts.headers ?? {}),
            },
            body: JSON.stringify({ decision }),
          });
          answered.decisionStatus = dec.status;
          answered.decisionBody = (await dec.text()).slice(0, 500);
        } catch (e) {
          answered.error = e instanceof Error ? e.message : String(e);
        }
      }
    }
    return { status: res.status, body, approvals, timedOut };
  } catch (e) {
    /*
     * An abort mid-read is reported with everything read so far rather than as a bare throw.
     * The partial body is the only evidence of how far the exchange got, and on a main-only
     * job it is not reproducible on demand.
     */
    if (timedOut) return { status: 0, body, approvals, timedOut: true };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** A one-line summary for an assertion message. Never throws, so it is safe inside `expect`. */
export function describeApprovals(r: StreamWithApprovalsResult): string {
  if (r.approvals.length === 0) return "no approvals were raised";
  return r.approvals
    .map(
      (a) =>
        `${a.actionName ?? "<unnamed>"} (${a.id}): ` +
        (a.error !== null
          ? `decision THREW ${a.error}`
          : `decision -> HTTP ${a.decisionStatus}${
              a.decisionBody ? ` ${a.decisionBody.slice(0, 120)}` : ""
            }`)
    )
    .join("; ");
}
