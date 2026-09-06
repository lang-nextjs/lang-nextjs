/**
 * EVERY `lifts` POINTER IN THE REPO NAMES AN OPEN ISSUE (#824, #835).
 *
 * READ THE SUBJECT LINE ABOVE LITERALLY. There are TWO `lifts` fields in this repo and this
 * checker now reads BOTH:
 *
 *     scripts/checks.json           unregistered[].lifts    COVERED HERE
 *     scripts/eject-subject-census.json  checkers[].lifts    COVERED HERE (#835)
 *
 * `scripts/checks.json` excuses a checker with a reason and a `lifts` field: `null` for "no
 * open ruling would change this", or an issue number for "this one might". The registration
 * gate validates the pointer's SHAPE — `/^#\d+$/` — and nothing validates that the issue it
 * names is still open.
 *
 * THE INCIDENT THAT PRODUCED #824 HAPPENED IN THE OTHER FILE, AND THIS CHECK WOULD NOT HAVE
 * CAUGHT IT. A pointer was cleared to `null` on the belief that the issue it named had closed.
 * It had not — the misreading came from a header clause describing that value's PREDECESSOR,
 * which did close. Two people read the same two-value field two opposite ways within an hour,
 * each citing the file. That field was the CENSUS's, not this one's. An earlier draft of this
 * header claimed this check "would have caught the incident that produced the issue"; it would
 * not have, because it reads a different file, and the claim is removed rather than softened.
 *
 * THE CENSUS FIELD IS WHERE EVERY LIVE POINTER ACTUALLY LIVES, WHICH IS WHY IT IS NOW READ.
 * Measured: `checks.json` holds 14 exclusions with ZERO non-null `lifts`; the census holds 55
 * entries with THREE, all "#780". So this check spent its whole life passing green having
 * examined nothing, while its own header named the file holding all three. A check whose NAME
 * is a claim it has never once been in a position to make is worse than an absent one, because
 * the name is what a reader trusts.
 *
 * THE REASON IT WAS DEFERRED WAS WRONG, AND THAT IS WHY IT IS SAFE TO UNDO. This header argued
 * the two fields have opposite lifecycles — the census is REGENERATED, so its repair would be
 * "re-run the producer" while this file's is "edit the entry", and one verdict must not span
 * both. THE AUDIT DOES NOT REPAIR THIS FIELD. `lifts: keep ? old.lifts : DEFAULT_LIFTS` keeps
 * the old value for exactly the entries able to raise a complaint, so a bad pointer is carried
 * and never repaired — driven, not argued: `lifts: "banana"` survived three runs unchanged
 * (assert-eject-subjects-classified.mjs:167-170). Both repairs are "edit the entry". Same field
 * name, and for THIS field the same lifecycle, so one verdict spanning both is correct.
 *
 * THE FAILURE NAMES ITS SOURCE ANYWAY. Two files wearing one field name is a real hazard —
 * it is #876's collision one file over — and a reader who sees a complaint needs to know which
 * artifact to open. Naming the source in the message gives them that without a rename, which is
 * deliberately NOT taken here while #876 has a rename in flight across the same file family.
 *
 * WHY IT IS A SEPARATE CHECK RATHER THAN AN ARM OF assert-checkers-registered. This needs the
 * board, so it needs `needs: "board-read"`. A channel applies to the WHOLE check: adding one to
 * the registration gate would make every arm of it — the population accounting, the orphan
 * proofs, the mute-button guard — skip on any machine without an authenticated `gh`. A guard
 * that total must not become conditional to gain one that is not.
 *
 * THE OTHER DIRECTION IS NOT CHECKED AND CANNOT BE. A wrong `null` — "no open ruling would
 * change this" where one exists — is unfalsifiable by any run, because it is a claim about
 * decisions nobody has made. That is #824's finding and it is why the enum split is a separate
 * change: the mechanism half of an exclusion IS checkable, and eleven of the thirteen entries
 * present when #824 was written cite a mechanism a run could verify. This closes the pointer
 * direction only, which is the half that has a defect with a date on it.
 *
 * WHAT IT ASSERTS TODAY: three pointers, all naming #780, which is open. `floor: 0` still
 * says an empty domain is the right answer rather than a collapse — pointers are added and
 * removed by ordinary work and there is no number this should be above, so a repo that has
 * ruled every open question legitimately reads zero. WHAT IT NO LONGER DOES IS CONFUSE THAT
 * WITH NOT LOOKING: an unreadable or unparseable source exits 2 rather than contributing a
 * silent zero, so a count of none always means "asked, and there was nothing to check".
 *
 * NO COUNT OF THE EXCLUSION LIST IS WRITTEN DOWN HERE ON PURPOSE. It was "thirteen" when this
 * file was written and became fourteen the same night, when #821 landed a checker that excused
 * itself. A number in prose is a measurement with no re-take, so the one number a reader needs
 * — how many entries this run actually looked at — is derived below and printed.
 *
 * Exit 0 every pointer is open · 1 one is closed · 2 the board could not be read.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `lifts` pointer in `checks.json`, as `{ source, checker, issue }`. */
export function pointers(cfg) {
  return (cfg.unregistered ?? [])
    .filter((e) => e.lifts !== null && e.lifts !== undefined)
    .map((e) => ({
      source: "scripts/checks.json",
      checker: e.checker,
      issue: String(e.lifts),
    }));
}

/**
 * Every `lifts` pointer in the census, same shape.
 *
 * THIS IS THE SOURCE THAT ACTUALLY HAS POINTERS (#835). Until this existed the check
 * read `checks.json` alone, where every entry is `lifts: null`, so it passed green
 * having examined ZERO pointers while all three live ones sat in the census. Its own
 * header said so. A check whose NAME is a claim it has never been in a position to make
 * is worse than an absent one, because the name is what a reader trusts.
 */
export function censusPointers(census) {
  return Object.entries(census.checkers ?? {})
    .filter(([, e]) => e.lifts !== null && e.lifts !== undefined)
    .map(([name, e]) => ({
      source: "scripts/eject-subject-census.json",
      checker: name,
      issue: String(e.lifts),
    }));
}

/**
 * Which pointers name something that is not an open issue, and which could not be asked
 * about at all — SEPARATED, because they are different verdicts.
 *
 * A CLOSED issue is a VIOLATION: the pointer says an exclusion is pending when the ruling
 * has been made. An UNREACHABLE board is a REFUSAL: the question could not be asked, which
 * is not a statement about the pointer. Collapsing them exits 1 on a throttled board and
 * reports three healthy pointers as stale — which is #844's hazard arriving through this
 * checker, and it only became reachable when #835 gave this check real pointers to read.
 * Before that it examined none, made no board calls, and passed green through any outage.
 *
 * `stateOf` is injected so the proof can drive every case without the network — a checker
 * whose only failing path needs a live API is one nobody watches fail.
 */
export function pointerComplaints(found, stateOf) {
  const violations = [];
  const refusals = [];
  for (const { source, checker, issue } of found) {
    const state = stateOf(issue);
    const where = source ? ` (${source})` : "";
    if (state === null || state === undefined)
      refusals.push(
        `${checker}${where} names ${issue} in \`lifts\` and the board could not be asked about it`
      );
    else if (state !== "OPEN")
      violations.push(
        `${checker}${where} names ${issue} in \`lifts\`, and ${issue} is ${state}. ` +
          `A pointer at a decision already taken says an exclusion is pending when nothing ` +
          `is pending — which is how #824 happened, in the other direction.`
      );
  }
  return { violations, refusals };
}

/*
 * A SOURCE THAT CANNOT BE READ IS A REFUSAL, NOT AN EMPTY DOMAIN. Both files yield a
 * pointer COUNT, and a count of zero from "I read it and there are none" is a correct
 * pass, while a zero from "I could not read it" is a vacuous green wearing the same
 * number. Nothing downstream can tell those apart from the count alone, so the read
 * failure is caught here and exits 2 — the question could not be asked.
 */
function readSource(rel) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf8");
  } catch (err) {
    console.error(
      `COULD NOT CHECK: ${rel} could not be read, so its \`lifts\` pointers were not\n` +
        `      examined. A zero pointer count from an unread file is indistinguishable\n` +
        `      from a file with no pointers, which is the state this check spent its\n` +
        `      whole life in (#835).\n\n  ${err?.message ?? err}`
    );
    process.exit(2);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(
      `COULD NOT CHECK: ${rel} is not parseable JSON, so its \`lifts\` pointers were\n` +
        `      not examined.\n\n  ${err?.message ?? err}`
    );
    process.exit(2);
  }
}

function main() {
  const cfg = readSource("scripts/checks.json");
  const census = readSource("scripts/eject-subject-census.json");
  const found = [...pointers(cfg), ...censusPointers(census)];

  /*
   * ONE CALL PER POINTER, AND NONE WHEN THERE ARE NONE. The board is a shared, throttled
   * resource; a check that queries it per RUN rather than per SUBJECT is a cost nobody
   * asked for. With zero pointers this makes zero calls.
   */
  const stateOf = (issue) => {
    try {
      const out = execFileSync(
        "gh",
        [
          "issue",
          "view",
          issue.replace(/^#/, ""),
          "--json",
          "state",
          "-q",
          ".state",
        ],
        { cwd: ROOT, encoding: "utf8" }
      );
      return out.trim().toUpperCase();
    } catch {
      return null;
    }
  };

  const { violations, refusals } = pointerComplaints(found, stateOf);

  /*
   * BOTH ARE PRINTED AND THE REFUSAL OUTRANKS (#689). A closed pointer is a real finding
   * and is reported even when the run also could not ask about others — but the RUN's
   * verdict is "could not ask", because a partial answer is not an answer. Exiting 1 here
   * on an unreachable board would report healthy pointers as stale, which is exactly what
   * a throttle produced tonight (#844).
   */
  if (violations.length > 0) {
    console.error(
      `FAIL: ${violations.length} \`lifts\` pointer(s) do not name an open issue:`
    );
    for (const b of violations) console.error(`  - ${b}`);
    console.error(
      `\n      A closed issue in \`lifts\` means the exclusion is waiting on a ruling that has\n` +
        `      already been made. Either the exclusion is now permanent — set \`lifts: null\` —\n` +
        `      or it is waiting on something else and the pointer should say which.`
    );
  }
  if (refusals.length > 0) {
    console.error(
      `COULD NOT CHECK: the board could not be asked about ${refusals.length} \`lifts\` pointer(s):`
    );
    for (const b of refusals) console.error(`  - ${b}`);
    console.error(
      `\n      THIS IS NOT A FAILURE OF THE POINTERS — it is the absence of an answer about\n` +
        `      them. A pointer whose issue could not be read is not thereby stale, and\n` +
        `      reporting it as stale would send someone to edit a census that is correct.` +
        (violations.length > 0
          ? `\n      The ${violations.length} closed pointer(s) above ARE findings and stand.`
          : "")
    );
    process.exit(2);
  }
  if (violations.length > 0) process.exit(1);

  const examined =
    (cfg.unregistered ?? []).length + Object.keys(census.checkers ?? {}).length;
  reportSubject(
    found.length,
    "`lifts` pointer(s) checked against the board, across BOTH sources"
  );
  console.log(
    found.length === 0
      ? `PASS: no \`lifts\` pointer exists in EITHER source, so there is none to be\n` +
          `      stale. ${examined} entr${
            examined === 1 ? "y" : "ies"
          } were read across\n` +
          `      scripts/checks.json and scripts/eject-subject-census.json, and every one\n` +
          `      carries \`lifts: null\` — permanent, which this check cannot verify and does\n` +
          `      not claim to. Zero here means the question was asked and had no subject;\n` +
          `      an unreadable source exits 2 instead.`
      : `PASS: every \`lifts\` pointer names an open issue, out of ${examined} entr${
          examined === 1 ? "y" : "ies"
        } read across both sources.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
