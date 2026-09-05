/**
 * A `lifts` POINTER NAMES AN OPEN ISSUE (#824).
 *
 * `scripts/checks.json` excuses a checker with a reason and a `lifts` field: `null` for "no
 * open ruling would change this", or an issue number for "this one might". The registration
 * gate validates the pointer's SHAPE — `/^#\d+$/` — and nothing validates that the issue it
 * names is still open.
 *
 * THAT GAP IS NOT HYPOTHETICAL; IT IS #824'S OWN INCIDENT. A pointer was cleared to `null` on
 * the belief that the issue it named had closed. It had not — the misreading came from a
 * header clause describing that value's PREDECESSOR, which did close. Two people then read the
 * same two-value field two opposite ways within an hour, each citing the file. A checker
 * asserting the pointer is open would have caught it at the moment of the edit rather than by
 * luck an hour later.
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
 * WHAT IT ASSERTS TODAY: nothing, because there are zero pointers in the tree — every entry's
 * `lifts` is `null`. `floor: 0` says that empty domain is the right answer here rather than a
 * collapse. The check exists for the next pointer someone adds, and its subject line reports
 * the count so a reader can see when it stops being vacuous.
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

/** Every `lifts` pointer in the file, as `{ checker, issue }`. */
export function pointers(cfg) {
  return (cfg.unregistered ?? [])
    .filter((e) => e.lifts !== null && e.lifts !== undefined)
    .map((e) => ({ checker: e.checker, issue: String(e.lifts) }));
}

/**
 * Which pointers name something that is not an open issue.
 *
 * `stateOf` is injected so the proof can drive every case without the network — a checker
 * whose only failing path needs a live API is one nobody watches fail.
 */
export function pointerComplaints(found, stateOf) {
  const bad = [];
  for (const { checker, issue } of found) {
    const state = stateOf(issue);
    if (state === null || state === undefined)
      bad.push(
        `${checker} names ${issue} in \`lifts\` and the board could not be asked about it`
      );
    else if (state !== "OPEN")
      bad.push(
        `${checker} names ${issue} in \`lifts\`, and ${issue} is ${state}. ` +
          `A pointer at a decision already taken says an exclusion is pending when nothing ` +
          `is pending — which is how #824 happened, in the other direction.`
      );
  }
  return bad;
}

function main() {
  const cfg = JSON.parse(
    readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
  );
  const found = pointers(cfg);

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

  const bad = pointerComplaints(found, stateOf);
  if (bad.length > 0) {
    console.error(
      `FAIL: ${bad.length} \`lifts\` pointer(s) do not name an open issue:`
    );
    for (const b of bad) console.error(`  - ${b}`);
    console.error(
      `\n      A closed issue in \`lifts\` means the exclusion is waiting on a ruling that has\n` +
        `      already been made. Either the exclusion is now permanent — set \`lifts: null\` —\n` +
        `      or it is waiting on something else and the pointer should say which.`
    );
    process.exit(1);
  }

  const examined = (cfg.unregistered ?? []).length;
  reportSubject(found.length, "`lifts` pointer(s) checked against the board");
  console.log(
    found.length === 0
      ? `PASS: no exclusion names an issue in \`lifts\`, so there is no pointer to be stale.\n` +
          `      All ${examined} entr${
            examined === 1 ? "y is" : "ies are"
          } \`null\`, which this check cannot verify and\n` +
          `      does not claim to. That count is read from the file on every run rather than\n` +
          `      written here, because it moved the night this check was authored.`
      : `PASS: every \`lifts\` pointer names an open issue, out of ${examined} exclusion(s) read.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
