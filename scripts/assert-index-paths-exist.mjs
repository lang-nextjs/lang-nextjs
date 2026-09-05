#!/usr/bin/env node
/**
 * assert-index-paths-exist.mjs — the scripts index names files that are actually there.
 *
 * `.planning/scripts-question-index.md` maps questions to the scripts whose headers already
 * answer them. It exists because three sessions in one evening re-derived conclusions already
 * written in `scripts/` — the streak-not-rate framing, the flake-rate measurement, and the
 * defect class #328 already names.
 *
 * WHAT THIS CAN AND CANNOT ENFORCE, stated first because the gap is the whole design.
 *
 *   CANNOT  that a description still matches its file. That is a claim about meaning and no
 *           checker settles it. The index says so itself: where the two disagree, the FILE is
 *           right.
 *   CAN     that every file it names EXISTS. That is cheap, total, and it catches the common
 *           decay — a script renamed or deleted while the index kept pointing at it.
 *
 * A weak check that can fail beats a strong claim that cannot. Without this, an index whose
 * every entry had rotted would look exactly like one that was still true, which is the shape
 * this repository keeps removing.
 *
 * THE PENDING LIST IS SELF-EXPIRING, AND THAT IS DELIBERATE. Entries under "Pending" name
 * files that do not exist on `main` yet because they arrive with an open PR. A pending name
 * that DOES now exist is an ERROR, not a pass: the note has become false, and a stale
 * exception is how an allowlist quietly grows into a blanket. So the list cannot outlive its
 * reason without going red and naming the line to delete.
 *
 * THE VACUITY FLOOR IS NOT DECORATION. An index that had been truncated, or whose formatting
 * had drifted so nothing matched, would name zero files — and "all zero of them exist" is a
 * pass. So a run finding implausibly few names REFUSES rather than passing, because "I could
 * not read the index" must not be spelled the same as "the index is fine".
 *
 * Exit codes:  0  every named file exists, and no pending entry has expired
 *              1  a named file is missing, or a pending entry is stale
 *              2  the index could not be read, or yielded too few names to be trusted
 *
 * Usage: node scripts/assert-index-paths-exist.mjs [--index PATH] [--floor N]
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every backticked script filename in the document, deduplicated, in order. */
export function namedScripts(md) {
  const out = [];
  for (const m of md.matchAll(/`([A-Za-z0-9._-]+\.(?:mjs|sh))`/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Names under the "## Pending" heading, which are allowed to be absent.
 *
 * SCOPED TO THE LIST ITEMS, NOT TO THE SECTION — and the first version was not, which this
 * checker caught on its own index within a minute of being written. The section opens with a
 * sentence naming `assert-index-paths-exist.mjs`, so a section-wide scan handed THIS FILE an
 * exemption it had never been granted. A pattern answering a broader question than the one
 * asked, which is the defect the index itself is about.
 *
 * An exemption must therefore be a deliberate list entry. Prose that merely mentions a script
 * — in this section or any other — confers nothing.
 */
export function pendingScripts(md) {
  /*
   * WALKED, NOT MATCHED WITH A LOOKAHEAD, because the lookahead was wrong in a way that only
   * showed up under a fixture. It ended `(?=^##\s|\Z)` — and `\Z` IS NOT JAVASCRIPT. It is a
   * Python/PCRE anchor; JS reads it as a literal "Z". So the section parsed only when another
   * `##` heading happened to follow it, and a Pending section placed LAST in the file matched
   * nothing and silently returned no exemptions at all.
   *
   * It passed against the real index purely because "## Staleness" sits underneath. Moving one
   * section would have broken it, and the symptom — every pending file reported missing —
   * points at the index rather than at this parse.
   */
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Pending\b/.test(l));
  if (start === -1) return [];
  const items = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    if (/^\s*[-*]\s/.test(l)) items.push(l);
  }
  return namedScripts(items.join("\n"));
}

function main() {
  const arg = (f, d) => {
    const i = process.argv.indexOf(f);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const indexPath = resolve(
    arg("--index", join(ROOT, ".planning/scripts-question-index.md"))
  );
  const floor = Number(arg("--floor", "40"));

  let md;
  try {
    md = readFileSync(indexPath, "utf8");
  } catch (e) {
    console.error(
      `COULD NOT COMPUTE: ${indexPath} is unreadable — ${e.message}\n` +
        `      This checks an index against the tree; with no index there is nothing to check,\n` +
        `      and reporting that as a pass would assert a correspondence never examined.`
    );
    process.exit(2);
  }

  const named = namedScripts(md);
  if (named.length < floor) {
    console.error(
      `COULD NOT COMPUTE: found only ${named.length} script names in the index, expected at least ${floor}.\n` +
        `      Either it was truncated or its formatting drifted so the scan matched nothing.\n` +
        `      "All zero named files exist" is a pass, which is why this refuses instead.`
    );
    process.exit(2);
  }

  const pending = pendingScripts(md);
  const missing = named.filter(
    (n) => !pending.includes(n) && !existsSync(join(ROOT, "scripts", n))
  );
  const expired = pending.filter((n) => existsSync(join(ROOT, "scripts", n)));

  for (const n of missing)
    console.error(
      `  MISSING  scripts/${n} — named in the index, not in the tree`
    );
  for (const n of expired)
    console.error(
      `  EXPIRED  scripts/${n} — listed as Pending but it EXISTS now; delete that line`
    );

  if (missing.length || expired.length) {
    console.error(
      `\nFAIL: the index and the tree disagree — ${missing.length} missing, ${expired.length} stale pending.\n` +
        `      This does NOT check that any description is still accurate; nothing does. It checks\n` +
        `      only that the files named are there, which is the decay that can be caught.`
    );
    process.exit(1);
  }

  reportSubject(named.length, "script(s) named in the index");
  console.log(
    `ok: all ${named.length} scripts named in the index exist` +
      (pending.length
        ? `, and ${pending.length} pending entr${
            pending.length === 1 ? "y is" : "ies are"
          } still genuinely absent`
        : "")
  );
}

if (invokedAsProgram(import.meta.url)) main();
