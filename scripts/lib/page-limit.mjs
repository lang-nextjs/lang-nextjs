/**
 * A FETCH THAT RETURNED EXACTLY ITS PAGE LIMIT CANNOT BE TOLD FROM A TRUNCATED ONE.
 *
 * `gh pr list --limit N` returning N is indistinguishable from a board with more than N. Every
 * verdict downstream is then about a SUBSET, reported as though it were the whole. The repository
 * already carried this guard once, in `assert-board-declarations-agree.mjs` as "GUARD 1b — A FETCH
 * AT THE PAGE SIZE IS NOT A BOARD (#735)", and three of us wrote unguarded bounded fetches anyway,
 * because the knowledge sat in one checker and was not reachable from the next person's question.
 *
 * WHICH GUARD A CALL SITE NEEDS DEPENDS ON ONE THING, AND IT IS NOT STYLE: does the check hold an
 * INDEPENDENT EXPECTATION to test the fetch against?
 *
 *   it does      refuse on the CONSEQUENCE — name the expected thing whose absence the truncation
 *                could explain. Precise, and no false positive when the page is legitimately full.
 *                `assert-action-pin-comments-resolve.mjs` refuses per PIN; a pin outside the tag
 *                window is unresolvable, and it says so about that pin.
 *                `assert-bot-silence-is-classified.mjs` refuses per ECOSYSTEM.
 *
 *   it does not  refuse on the PROXY — the count reaching the limit is the only signal available,
 *                because "an item I expected is missing" is not a question the check can ask.
 *                `assert-armed-prs-are-covered-by-a-review.mjs` fetches the open board and the
 *                fetch IS its subject. It takes the false positive at exactly-N deliberately: at
 *                the page size the two cases are genuinely indistinguishable, and the repair is to
 *                raise the limit, which is a one-line change a reader can see.
 *
 * THIS IS A LIBRARY AND NOT A CHECKER, deliberately. A checker asserting "every bounded fetch uses
 * this" would need an exception for `action-pin-comments`, which correctly uses neither — it
 * refuses per item against its own list and never reads the page size. One exception whose repair
 * is not a repair, because the code is already right, is an exception list with extra steps.
 */

/** Whether a fetch came back at or above the bound it was given. */
export function atPageLimit(count, limit) {
  return (
    Number.isInteger(count) &&
    Number.isInteger(limit) &&
    limit > 0 &&
    count >= limit
  );
}

/**
 * The refusal sentence for a PROXY-shaped call site, or null when the fetch is trustworthy.
 *
 * It states BOTH numbers, because a count whose bound is not printed cannot be checked by whoever
 * reads the log — 615 from a limit of 1000 is a measurement and 100 from a limit of 100 is not.
 */
export function pageLimitRefusal(count, limit, what) {
  if (!atPageLimit(count, limit)) return null;
  return (
    `\`${what}\` returned ${count} at --limit ${limit}. A full page cannot be told apart from a ` +
    `truncated one, so this set may be a SUBSET and every verdict about it would be about the ` +
    `wrong subject. Raise the limit above the real population.`
  );
}
