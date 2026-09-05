#!/usr/bin/env node
/**
 * Fork property: NO RETAINED CI STEP OR SCRIPT INVOKES A WORKSPACE THIS TREE DOES NOT HAVE.
 *
 * Stated over the tree, not over a grep for a rung's name. The question is not "does any file
 * mention open-swe" — prose does, legitimately, and counting it was the 135-hit mistake. The
 * question is whether anything would RUN `pnpm --filter <x>` for an `<x>` that is not a
 * workspace here.
 *
 * True on main, where every filtered workspace exists. True in a fork, where the invocations
 * that would break are guarded by scripts/has-rung.mjs. It is the same statement either way,
 * which is what makes it a property rather than a fork-specific patch.
 *
 * Usage: node scripts/assert-no-missing-workspace-invocations.mjs [--cwd DIR]
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { reportSubject } from "./lib/subject.mjs";

const argv = process.argv.slice(2);
const i = argv.indexOf("--cwd");
const CWD =
  i >= 0
    ? resolve(argv[i + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: CWD,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

/** Every workspace name this tree actually contains. */
const workspaces = new Set();
for (const f of tracked) {
  if (!/^(packages|apps)\/[^/]+\/package\.json$/.test(f)) continue;
  try {
    const n = JSON.parse(readFileSync(join(CWD, f), "utf8")).name;
    if (n) workspaces.add(n);
  } catch {
    /* unreadable manifest is not this check's subject */
  }
}
if (workspaces.size === 0) {
  console.error(
    "FAIL: found no workspaces at all — the walk is broken, not the tree."
  );
  process.exit(1);
}

/**
 * Blank comment lines rather than removing them, so reported line numbers are the file's real
 * ones. Filtering shifted every index after the first comment and the tool cited line 135 for a
 * violation on line 202 — a diagnostic that sends the reader to the wrong place is barely better
 * than no diagnostic.
 */
const stripComments = (src, file) =>
  /\.(ya?ml|sh)$/.test(file)
    ? src
        .split("\n")
        .map((l) => (/^\s*#/.test(l) ? "" : l))
        .join("\n")
    : src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/^[ \t]*\/\/.*$/gm, "");

const violations = [];
let invocations = 0;
for (const f of tracked) {
  if (!/\.(ya?ml|sh|mjs|ts)$/.test(f)) continue;
  if (!existsSync(join(CWD, f))) continue;
  const src = stripComments(readFileSync(join(CWD, f), "utf8"), f);
  const lines = src.split("\n");
  lines.forEach((line, n) => {
    // Anchored on `pnpm`. A bare `--filter` is not pnpm's: docker CLI uses it too, and matching
    // it flagged `--filter label=` / `--filter name=` in the open-swe sandbox spec. Measuring the
    // flag instead of the invocation is the same mistake as counting a word instead of a
    // dependency — third time tonight, and the third time the fix is to narrow the subject.
    for (const m of line.matchAll(
      /\bpnpm\b[^\n]*?--filter[= ]'?"?([@\w./-]+)'?"?/g
    )) {
      const name = m[1];
      if (name.startsWith("!")) continue; // exclusion filter, not an invocation
      // A PATH FILTER IS NOT A WORKSPACE NAME. `--filter ./packages/*` selects by
      // location, so there is no workspace called "./packages/*" to look up and
      // the tree cannot "lack" it — the glob simply matches fewer directories in
      // a smaller fork, which is exactly the behaviour this check wants. Flagging
      // it is the same false positive as flagging docker's `--filter` or an `!`
      // exclusion: a real string that is not the kind of thing being checked.
      //
      // Deliberately narrow. Only a leading `./` or `../` counts as a path; a
      // bare `packages/foo` is left alone because pnpm would treat that as a
      // name-or-path and the ambiguity is not ours to resolve silently.
      if (name.startsWith("./") || name.startsWith("../")) continue;
      invocations++;
      // `continue`, NOT `return`. These sit inside the per-match loop but the callback is
      // per-LINE, so returning abandoned every later match on the same line: a resolving filter
      // stopped the scan before a missing one after it. `pnpm --filter a build && pnpm --filter b
      // build` on one `run:` line is ordinary CI, and it passed. Caught by this file's
      // two-invocations-on-one-line case, which is why that case exists.
      if (workspaces.has(name)) continue;
      // Guarded invocations are fine: the surrounding `if` never runs in a tree without the rung.
      //
      // The guard must name THE SAME workspace, and the window is 25 lines because a real guard
      // block is 8+ (if / message / exit / fi) and a 6-line window missed the very guard this
      // check exists to credit — it flagged dev-demo.sh's guarded call as unguarded.
      //
      // KNOWN LIMIT, stated rather than hidden: this credits a guard appearing anywhere in the
      // preceding 25 lines. A file that guards `open-swe` and then invokes it again, unguarded,
      // further down within that window would pass. Narrow, and the alternative is parsing shell
      // and YAML control flow, which is a worse trade for this check.
      const window = lines.slice(Math.max(0, n - 25), n).join("\n");
      if (
        new RegExp(
          `has-rung\\.mjs["']?\\s+${name.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}\\b`
        ).test(window)
      )
        continue;
      violations.push(
        `${f}:${n + 1} invokes --filter ${name}, which is not a workspace here`
      );
    }
  });
}

// Non-vacuity: a walk finding no invocations at all would pass while proving nothing.
if (invocations === 0) {
  console.error(
    "FAIL: found zero --filter invocations — the scan is broken, not the tree."
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `FAIL: ${violations.length} invocation(s) of a workspace this tree lacks:`
  );
  for (const v of violations) console.error(`       ${v}`);
  process.exit(1);
}
reportSubject(
  invocations,
  // NOT "pnpm --filter ..." — this file is inside its own subject, and that
  // wording made the scan read `invocation` as a workspace name and fail.
  "--filter invocation(s) checked against the workspace list"
);
console.log(
  `PASS: ${invocations} --filter invocation(s) checked against ${workspaces.size} workspaces; ` +
    `every one resolves or is guarded.`
);
