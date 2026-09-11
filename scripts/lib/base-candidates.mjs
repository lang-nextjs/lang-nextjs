/**
 * THE REFS A CHANGE-SCOPED CHECKER MAY TAKE AS ITS BASE, IN ORDER (#1210).
 *
 * `assert-formatted` and `assert-no-undeclared-reverts` scope their subject to "what this change
 * touches", so each needs a base. Both carried the same candidate list, the PR's base branch,
 * then `origin/main`, then local `main`, and both had the same defect.
 *
 * ON A CLEAN CHECKOUT AT MAIN'S TIP, `origin/main` equals HEAD and is skipped, so the base fell
 * through to the checkout's LOCAL `main`, wherever that branch was last pulled. DEV1 measured
 * it: at `7d9e5e30`, with local `main` at `3e6f168a`, `assert-no-undeclared-reverts` compared
 * 27 files of other people's merged commits instead of the 5 in the pushed commit, and
 * `assert-formatted` read 18 files where the same commit reads 0 once the base is right. The
 * position of a local branch is a fact about the checkout's history, not about the commit.
 *
 * So local `main` is a candidate ONLY WHEN THERE IS NO `origin/main` AT ALL: a checkout without
 * the remote-tracking branch, where it is the only base there is. When `origin/main` exists it
 * is the authority. If it equals HEAD, both checkers fall through to their documented fallback:
 * HEAD's own parent, the push-to-main subject.
 *
 * ONE LIST, TWO CALLERS. It was written twice and went wrong twice in the same way. Each caller
 * keeps its own selection rule (a differing sha in one, a merge-base in the other); only the
 * order of candidates is shared.
 *
 * @param {(ref: string) => string | null} resolve  the caller's own ref resolver (sha or null)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function baseCandidates(resolve, env = process.env) {
  const hasOriginMain = Boolean(resolve("origin/main"));
  return [
    env.GITHUB_BASE_REF && `origin/${env.GITHUB_BASE_REF}`,
    "origin/main",
    hasOriginMain ? null : "main",
  ].filter(Boolean);
}
