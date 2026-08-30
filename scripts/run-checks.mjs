#!/usr/bin/env node
/**
 * Runs every check declared in scripts/checks.json, and RECORDS WHAT IT ACTUALLY RAN.
 *
 * ci.yml grew to 55 `pnpm` steps in one job, hand-written, all appending to the same region —
 * three PRs in one hour collided there. This replaces the six proof-first ones with a list
 * plus a runner. The list is not a description of what CI does; the runner iterates it and
 * ci.yml invokes the runner, so an entry IS an execution.
 *
 * THE RUN RECORD IS THE POINT, more than the consolidation was.
 *
 * assert-checker-proof-pairing.mjs answers "which checkers exist and where is each proved" by
 * regex over workflow YAML, resolving `pnpm <name>` indirection as it goes. What that can
 * establish is that a workflow's TEXT MENTIONS A SCRIPT. It cannot distinguish that from the
 * step having run. Latent in ci.yml today — zero of its checker steps are conditional — and
 * live across workflows: has-rung.mjs gates steps with a shell `if` inside `run:` blocks in
 * cross-version.yml and e2e.yml, which no YAML parse can see.
 *
 * So this writes `.checks-run.json`: name, exit status and duration for each check that
 * actually executed. Pairing reads that instead of inferring, and a declared check the runner
 * never ran shows up as a HOLE rather than as a pass. The record is produced by execution and
 * the declaration is the expectation, which is what keeps the two from being circular.
 *
 * ANNOTATIONS, NOT A SUMMARY TABLE. Collapsing 55 named steps into one costs the step name
 * that used to tell you what broke before you opened a log. `::error title=…::` replaces it
 * with more than it took away — the step name said WHICH STEP, an annotation says which
 * checker and why — and annotations are queryable over GraphQL, which is what made #372 and
 * #368 one query instead of an hour. A runner that swallowed a failure into a printed table
 * would be the regression this refactor exists to prevent, so run-checks.selftest.mjs watches
 * a real failure produce a real annotation rather than assuming it does.
 *
 * Usage: node scripts/run-checks.mjs [--cwd DIR] [--record PATH] [--list PATH]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ROOT = resolve(
  argOf("--cwd", join(dirname(fileURLToPath(import.meta.url)), ".."))
);
const LIST = resolve(argOf("--list", join(ROOT, "scripts", "checks.json")));
const RECORD = resolve(argOf("--record", join(ROOT, ".checks-run.json")));

/** One line, enough to know what broke without opening the log. */
function firstMeaningfulLine(text) {
  const line = text
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .find((l) => /^(FAIL|Error|error|✘|✗)/.test(l) || /\bFAIL\b/.test(l));
  return (line ?? text.split("\n").find((l) => l.trim()) ?? "no output").slice(0, 400);
}

/** GitHub swallows a bare newline inside an annotation; %0A is how a multi-line one is sent. */
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function runChecks({ root = ROOT, list = LIST, record = RECORD } = {}) {
  if (!existsSync(list)) {
    return { ok: false, fatal: `no check list at ${list}`, ran: [] };
  }
  const declared = JSON.parse(readFileSync(list, "utf8")).checks ?? [];
  if (declared.length === 0) {
    // A list with nothing in it runs nothing and would exit 0. "Nothing declared" and
    // "everything passed" are different answers and must not share an exit code.
    return { ok: false, fatal: `${list} declares no checks`, ran: [] };
  }

  const ran = [];
  for (const c of declared) {
    // PROOF FIRST, then the checker — in that order, as one unit. This ordering used to live
    // in six `&&` chains and is now a property of the runner, so the seventh cannot omit it.
    for (const [phase, script] of [
      ["proof", c.proof],
      ["checker", c.checker],
    ]) {
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(root, script)], {
        cwd: root,
        encoding: "utf8",
      });
      const status = r.status === 0 ? "pass" : "fail";
      ran.push({
        name: c.name,
        phase,
        script,
        status,
        exit: r.status ?? -1,
        ms: Date.now() - started,
      });
      if (status === "fail") {
        const why = firstMeaningfulLine((r.stdout ?? "") + (r.stderr ?? ""));
        console.log(
          `::error title=${esc(c.name)} (${phase})::${esc(script)} exited ${r.status}. ${esc(why)}`
        );
        console.error(`\n--- ${c.name} (${phase}) FAILED: ${script} ---`);
        console.error((r.stdout ?? "") + (r.stderr ?? ""));
        break; // a checker whose proof failed tells you nothing; do not run it
      }
      console.log(`  ok  ${c.name} (${phase})  ${script}`);
    }
  }

  writeFileSync(record, JSON.stringify({ ran }, null, 2) + "\n");
  return { ok: ran.every((r) => r.status === "pass"), ran, record };
}

function main() {
  const { ok, fatal, ran, record } = runChecks();
  if (fatal) {
    console.error(`FAIL: ${fatal}`);
    console.error(`      Nothing was executed, which is not the same as nothing failing.`);
    process.exit(2);
  }
  const failed = ran.filter((r) => r.status === "fail");
  console.log();
  if (failed.length) {
    console.error(
      `FAIL: ${failed.length} of ${ran.length} phase(s) failed — ` +
        `${[...new Set(failed.map((f) => f.name))].join(", ")}.\n` +
        `      Each is annotated above by name; the record is at ${record}.`
    );
    process.exit(1);
  }
  const names = [...new Set(ran.map((r) => r.name))];
  console.log(
    `PASS: ${names.length} declared check(s), ${ran.length} phase(s), all green.\n` +
      `      ${names.join(", ")}\n` +
      `      Recorded to ${record} — pairing reads that rather than inferring from YAML.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
