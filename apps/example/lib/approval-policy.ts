/**
 * WHICH OF THIS APP'S BACKEND TOOLS ARE READ-ONLY (#653).
 *
 * The Python backends gate on a policy the CLIENT sends, and refuse a request
 * that carries none — deliberately, since "no policy" would otherwise be read as
 * "nothing is dangerous", reporting a decision nobody made. So the shipped
 * surface has to answer, and this is the answer.
 *
 * DERIVED FROM THE BACKEND'S INVENTORY, NOT COPIED FROM open-swe. Both Python
 * planes' `_common.py` declare exactly three `@tool` functions — `increment`,
 * `get_counter`, `web_search`. open-swe's list additionally carries `read_file`,
 * `ls`, `glob`, `grep`, which come from ITS filesystem middleware and do not
 * exist here. Listing them would be harmless at runtime and misleading in the
 * way an allowlist must not be: it would suggest a surface was considered when
 * it was not.
 *
 * AND IT IS THE ALLOWLIST THAT CROSSES THE WIRE, NOT THE GATED NAMES. The
 * backend's `requiresApproval` is open-ended: anything absent from the allowlist
 * is gated, so an UNRECOGNISED tool prompts. Sending gated names instead could
 * only enumerate what this app already knows about, and a tool it has never seen
 * would arrive ungated — the fail-closed rule inverted at exactly the moment it
 * exists for.
 *
 * BOTH HALVES ARE DECLARED, AND THAT IS WHAT MAKES THE PAIR CHECKABLE. Only
 * `READ_ONLY_TOOLS` is sent; `GATED_TOOLS` exists so the classification is TOTAL
 * and a checker can compare the union against the backend's real `@tool` set.
 * With one list, a newly-added backend tool would be gated by default and
 * silently unclassified — safe, and decided by nobody.
 * See scripts/assert-example-approval-policy-covers-tools.mjs.
 */

/** Sent as `approvalPolicy.readOnlyTools`. These run without prompting. */
export const READ_ONLY_TOOLS: readonly string[] = ["get_counter", "web_search"];

/**
 * Not sent — declared so the classification is total and can be asserted.
 * `increment` mutates a counter, which is why every approval test uses it: the
 * effect is observable.
 */
export const GATED_TOOLS: readonly string[] = ["increment"];
