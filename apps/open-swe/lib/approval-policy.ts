/**
 * WHICH TOOL CALLS THE AGENT MUST STOP FOR (#160 gap 1).
 *
 * THE RULING: gate tools that MUTATE, let reads through. A gate that fires on
 * every read_file is a gate people learn to click through, and a safety control
 * users habituate to is worse than none because it manufactures consent. "The
 * agent paused before changing something" is a promise worth keeping and one a
 * person can actually reason about.
 *
 * THE LIST LIVES HERE, NOT IN packages/server, and that is deliberate. The
 * gating transform takes a policy callback; hardcoding names inside it would
 * make the transform a second source of truth about what mutates, inherited by
 * every rung. MCP tools arrive with names this repo has never seen, so any
 * fixed list is wrong within a month. open-swe owns its own tool inventory, so
 * open-swe owns the question of which of them are dangerous.
 *
 * FAILING CLOSED ON THE UNKNOWN. A tool whose name we do not recognise is
 * gated, not waved through. That is the uncomfortable direction — it means a
 * new read-only MCP tool will prompt until someone adds it below — but the
 * alternative is that an unrecognised *destructive* tool runs unprompted, and
 * of the two mistakes only one is unrecoverable. An operator who is over-asked
 * complains; an operator who is under-asked loses a file.
 */

/**
 * Tools known to be read-only. Everything else is treated as mutating.
 *
 * Recognised from the built-in inventory the Python backends expose plus the
 * filesystem middleware's read surface. Add to this list when a tool is
 * verified not to change anything — never as a way to stop a prompt appearing.
 */
export const READ_ONLY_TOOLS: readonly string[] = [
  "read_file",
  "ls",
  "glob",
  "grep",
  "get_counter",
  "web_search",
];

/**
 * True when a tool call must be approved before it runs.
 *
 * Unknown names return true — see "failing closed on the unknown" above.
 */
export function requiresApproval(toolName: string): boolean {
  return !READ_ONLY_TOOLS.includes(toolName);
}

/**
 * How long a pending approval stays valid. Five minutes is a business rule
 * about how long a human may reasonably take, and is deliberately NOT the
 * proxy's drain grace — that one is an infrastructure cost (a pinned worker and
 * an open socket) and is much shorter. Conflating them means a user who closes
 * their tab pins a worker for the full five minutes.
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** The policy object the gating transform expects, built from the rules above. */
export function approvalPolicy(toolCall: {
  toolName: string;
}): { require: boolean; timeoutMs?: number } | undefined {
  return {
    require: requiresApproval(toolCall.toolName),
    timeoutMs: APPROVAL_TIMEOUT_MS,
  };
}
