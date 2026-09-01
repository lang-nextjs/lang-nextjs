#!/usr/bin/env node
/**
 * THE DOCS THAT ENUMERATE UPSTREAM'S GRAPHS ARE RE-MEASURED AGAINST UPSTREAM (#468).
 *
 * `rungs/5-software-developer-agent/langgraph.json` is vendored from Open SWE and
 * declares which graphs it registers. Several places in this repo restate that
 * list in prose. #454 guards the two TEST FIXTURES that copy it — but a fixture
 * is read by a runner, not by a person. The copies a human opens to decide what
 * is true are the prose ones, and nothing re-measured them.
 *
 * WHY NOT DERIVE THEM INSTEAD, which is the better answer wherever it is
 * available. It is not available here, and the repo already has the evidence:
 * `scripts/gen-rung-types.mjs` GENERATES the same sentence into
 * `packages/rungs/src/generated.ts`, and CI checks it. That derivation did not
 * remove the copy — it moved it up one level into a hand-maintained template
 * string in the generator, which is still a copy and still unchecked against
 * upstream. Deriving bought agreement between the generated file and the
 * template, and nothing about whether the template matches Open SWE. So prose
 * that makes an ARGUMENT ("three graphs that do not share a run") cannot be
 * generated from a JSON object without becoming worse than what it replaced.
 *
 * SUBJECT: MARKDOWN ONLY, AND THAT IS A BOUNDARY RATHER THAN AN OVERSIGHT.
 * Code comments restate this list too. In those, the names are ILLUSTRATION —
 * the load-bearing claim is the argument, and the fix there is to delete the
 * enumeration rather than guard it, which is tracked separately. Guarding a
 * decorative copy manufactures a coupling that was not there: a rename upstream
 * would then fail a test that has no stake in the answer. This checker covers
 * the copies that exist TO STATE THE LIST.
 *
 * BOTH HALVES OF THE CLAIM, BECAUSE EITHER ALONE PASSES A WRONG SENTENCE.
 * A names-only check passes "registers **two** graphs (manager, planner,
 * programmer)". A count-only check passes "registers **three** graphs (manager,
 * planner, sculptor)". The sentence asserts a number AND a membership, so both
 * are compared.
 *
 * SET EQUALITY HERE, SUBSET IN #454, AND THE DIFFERENCE IS NOT INCONSISTENCY.
 * #454 compares a FIXTURE, which legitimately carries ids upstream never
 * declared (`agent`, the bundled single-run backend), so requiring equality
 * there would need an allowlist. This sentence is an ENUMERATION OF UPSTREAM'S
 * REGISTRY: a name upstream does not have is wrong, and a missing one is wrong.
 * The direction follows from what the copy claims, not from a house style.
 *
 * REFUSES RATHER THAN PASSES when it cannot find a claim to check, because a
 * reworded sentence and an absent one look identical to a scan, and "no claims
 * found" is the same confident zero this repo keeps filing issues about.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
export const RUNG5_LANGGRAPH =
  "rungs/5-software-developer-agent/langgraph.json";
/*
 * NOT DOCUMENTATION OF CURRENT BEHAVIOUR, so not part of the subject.
 *
 * `test-results/` is a Playwright artifact directory: `pnpm checks` writes an
 * `error-context.md` into it, which drifted into the scan and moved the reported
 * file count between two runs of the same tree. A subject that changes because a
 * check ran is a subject nobody can reason about.
 *
 * DOT-DIRECTORIES ARE EXCLUDED TOO, and that is stated rather than left as an
 * accident of the leading-dot rule: `.planning/` alone holds 360 markdown files
 * of session notes, which are a historical record and not a claim about what
 * upstream registers today. MEASURED, not assumed: grepping `.planning`,
 * `.github` and `test-results` for this claim pattern finds nothing, so the
 * exclusions hide no copy as the tree stands.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "playwright-report",
  "test-results",
]);

/**
 * Number words this checker can read. Hand-listed DELIBERATELY, and it is not
 * the kind of list that expires: it is English, not repo data. A count word
 * outside it is a refusal, never a pass — an unreadable claim is unchecked.
 */
const NUMBER_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** `registers <count> graphs (` — the shape of a sentence that enumerates them. */
const CLAIM = /registers\s+(?:\*\*)?([A-Za-z0-9]+)(?:\*\*)?\s+graphs?\s*\(/gi;

export function graphsDeclaredByUpstream(cwd) {
  const abs = path.join(cwd, RUNG5_LANGGRAPH);
  if (!existsSync(abs)) return null;
  const doc = JSON.parse(readFileSync(abs, "utf8"));
  const graphs = doc?.graphs;
  if (!graphs || typeof graphs !== "object" || Array.isArray(graphs)) {
    throw new Error(`${RUNG5_LANGGRAPH} has no \`graphs\` object to read`);
  }
  return Object.keys(graphs).sort();
}

export function markdownUnder(cwd) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.name.endsWith(".md")) out.push(path.relative(cwd, abs));
    }
  };
  walk(cwd);
  return out.sort();
}

/**
 * Every "registers N graphs (…)" claim in one document.
 *
 * The window runs to the CLOSING PAREN rather than to end-of-line, because the
 * enumeration wraps in both documents that make this claim today — reading one
 * line would silently truncate the list and compare against half of it.
 */
export function claimsIn(source) {
  const found = [];
  CLAIM.lastIndex = 0;
  let m;
  while ((m = CLAIM.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = source.indexOf(")", open);
    const line = source.slice(0, m.index).split("\n").length;
    if (close === -1) {
      found.push({ line, countWord: m[1], names: null, unclosed: true });
      continue;
    }
    const names = source
      .slice(open + 1, close)
      .split(/[,/]|\band\b/)
      .map((s) => s.replace(/[`*\s]/g, ""))
      .filter((s) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(s));
    found.push({ line, countWord: m[1], names, unclosed: false });
  }
  return found;
}

const parseCount = (w) => {
  const k = String(w).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, k))
    return NUMBER_WORDS[k];
  return /^\d+$/.test(k) ? Number(k) : null;
};

export function check({ cwd = process.cwd() } = {}) {
  const declared = graphsDeclaredByUpstream(cwd);
  if (declared === null) return { forked: true };
  const docs = markdownUnder(cwd);
  const claims = [];
  for (const rel of docs) {
    for (const c of claimsIn(readFileSync(path.join(cwd, rel), "utf8"))) {
      claims.push({ file: rel, ...c });
    }
  }
  const problems = [];
  for (const c of claims) {
    if (c.unclosed || !c.names || c.names.length === 0) {
      problems.push({
        ...c,
        kind: "unreadable",
        detail: "no closed (…) list of names",
      });
      continue;
    }
    const n = parseCount(c.countWord);
    if (n === null) {
      problems.push({
        ...c,
        kind: "unreadable",
        detail: `count word "${c.countWord}" not a number`,
      });
      continue;
    }
    if (n !== declared.length) {
      problems.push({
        ...c,
        kind: "count",
        detail: `says ${n}, upstream declares ${declared.length}`,
      });
    }
    const got = [...c.names].sort();
    if (JSON.stringify(got) !== JSON.stringify(declared)) {
      problems.push({
        ...c,
        kind: "names",
        detail: `says [${got.join(", ")}], upstream declares [${declared.join(
          ", "
        )}]`,
      });
    }
  }
  return { forked: false, declared, docs, claims, problems };
}

async function main() {
  const cwd = process.cwd();
  let r;
  try {
    r = check({ cwd });
  } catch (e) {
    console.error(
      `REFUSING: could not read upstream's graph list — ${e.message}`
    );
    process.exit(2);
  }

  if (r.forked) {
    console.log(
      `SKIPPED: ${RUNG5_LANGGRAPH} is not in this tree, so rung 5 was ejected and ` +
        `there is no upstream declaration to compare against. On a full ladder this ` +
        `check runs; the selftest proves it does not skip there.`
    );
    process.exit(0);
  }

  const { declared, docs, claims, problems } = r;

  if (claims.length === 0) {
    // REFUSES. A reworded sentence and a deleted one look identical from here,
    // and this checker exists because that list goes stale unnoticed.
    console.error(
      `REFUSING: scanned ${docs.length} markdown file(s) and found no ` +
        `"registers <count> graphs (...)" claim to check. Upstream declares ` +
        `${declared.length} (${declared.join(
          ", "
        )}). Either the documentation ` +
        `stopped stating the list — in which case delete this check — or the ` +
        `sentence was reworded past what this can read, in which case teach it ` +
        `the new phrasing. It does not report agreement over nothing.`
    );
    process.exit(2);
  }

  const unreadable = problems.filter((p) => p.kind === "unreadable");
  if (unreadable.length > 0) {
    for (const p of unreadable) {
      console.error(
        `REFUSING: ${p.file}:${p.line} — claim found but ${p.detail}.`
      );
    }
    process.exit(2);
  }

  if (problems.length > 0) {
    console.error(
      `FAIL: ${problems.length} documented claim(s) disagree with ` +
        `${RUNG5_LANGGRAPH}, which is vendored from upstream:\n`
    );
    for (const p of problems) {
      console.error(`    ${p.file}:${p.line}  [${p.kind}]  ${p.detail}`);
    }
    console.error(
      `\n  upstream declares ${declared.length}: ${declared.join(", ")}\n\n` +
        `  If upstream changed, update the prose in the same change. Do NOT relax\n` +
        `  this to names-only or count-only: each half passes a sentence the other\n` +
        `  catches.`
    );
    process.exit(1);
  }

  console.log(
    `PASS: ${claims.length} documented claim(s) across ${docs.length} markdown ` +
      `file(s) agree with upstream's ${declared.length} graphs ` +
      `(${declared.join(", ")}):\n` +
      claims
        .map(
          (c) =>
            `    ${c.file}:${c.line}  "${c.countWord}" + [${[...c.names]
              .sort()
              .join(", ")}]`
        )
        .join("\n")
  );
}

if (invokedAsProgram(import.meta.url)) await main();
