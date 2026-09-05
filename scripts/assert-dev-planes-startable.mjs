#!/usr/bin/env node
/**
 * EVERY RUNTIME THE MANIFEST DECLARES MUST BE ONE `pnpm dev` CAN START (#633).
 *
 * rungs.json declared three runtimes — django, fastapi, node — and scripts/dev-all.sh could
 * start two. `grep -c node-backend scripts/dev-all.sh` was 0, and so was `grep -c 8003`. The
 * node plane had a dev script, a compose file publishing :8003 and a /health endpoint the whole
 * time; nothing could bring it up from the command the repo tells people to run.
 *
 * WHY THAT WENT UNNOTICED FOR SO LONG, and why it needs a check rather than a fix. dev-all.sh
 * is invoked by PEOPLE, not by CI — it appears in no workflow and in no checks.json entry other
 * than this one. Every other gap this repo has closed was a checker misleading a pipeline;
 * this one is a script misleading a person at the moment they are least able to notice, because
 * they have nothing to compare it against. A developer who has never seen the node plane work
 * has no reason to think it should have started.
 *
 * The manifest is the authority, exactly as it is for the langfuse and run-axes guards: a
 * runtime declared there is a runtime this repo claims to have, and a claim nothing can start
 * is a claim nobody can check.
 *
 * WHAT THIS DOES NOT ASSERT. It cannot start a container, so it does not prove the plane comes
 * up — that needs docker and a model key and belongs in an e2e job. It proves the script has a
 * PATH to each declared runtime: a way to ask for it, a probe before declaring success, and a
 * teardown. A plane you can start and cannot stop is the same defect pointing the other way.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedAsProgram } from "./lib/is-main.mjs";

import { reportSubject } from "./lib/subject.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Runtime ids rungs.json declares, from every rung. */
export function declaredRuntimes(manifestText) {
  const manifest = JSON.parse(manifestText);
  const ids = new Set();
  for (const rung of manifest.rungs ?? [])
    for (const [id, cfg] of Object.entries(rung.runtimes ?? {}))
      if (cfg?.topologiesSource) ids.add(id);
  return ids;
}

/**
 * How a runtime shows up in dev-all.sh. Derived from the id, not a second literal list — a
 * fourth runtime named in rungs.json is checked without anyone editing this file, which is the
 * whole point given that forgetting to edit a second list is how #633 happened.
 *
 * `fastapi` is the default plane and has no opt-in flag, which is correct rather than an
 * exception: it is started unconditionally, so requiring `--with-fastapi` would be asserting a
 * flag that should not exist. What every runtime must have is a way to be ASKED for — default
 * counts — plus a probe and a teardown.
 */
export function planeGaps(id, script) {
  const gaps = [];
  const dir = `apps/${id}-backend`;
  const hasDir = existsSync(join(ROOT, dir));

  if (!hasDir)
    return [
      `rungs.json declares runtime "${id}" but ${dir}/ does not exist, so there is nothing ` +
        `for dev-all.sh to start. Either the manifest names a plane that was removed, or the ` +
        `directory is named something this check cannot derive — both need a human.`,
    ];

  if (!script.includes(dir))
    gaps.push(
      `dev-all.sh never mentions ${dir}. "One command, everything up" is the sentence at the ` +
        `top of that script, and a declared runtime it cannot start makes that sentence false ` +
        `for whoever needed that plane.`
    );

  /*
   * A probe before success — located STRUCTURALLY, not by naming convention.
   *
   * The first version of this looked for a wait_for whose text mentioned the runtime id or
   * `<ID>_PORT`, and reported fastapi as unprobed. fastapi IS probed; its variables are named
   * BACKEND_PORT and its label is "backend", because it is the default plane and predates the
   * others. The check was measuring a naming convention and reporting it as a missing probe.
   *
   * Special-casing fastapi would have been a skip list in the check whose entire subject is a
   * plane that nobody had listed. So the rule is now positional: the plane's directory and a
   * wait_for must appear within the same stretch of script. That is what "this block starts it
   * and then asks it something" actually looks like, whatever the variables are called.
   */
  const lines = script.split("\n");
  const OTHER_PLANE = /apps\/([a-z0-9-]+)-backend/;
  const near = lines.some((line, i) => {
    if (!line.includes(dir)) return false;
    /*
     * FORWARD, AND STOPPING AT THE NEXT PLANE. A symmetric ±20-line window looked right and was
     * not: it happily found the PREVIOUS plane's wait_for and pronounced this one probed. The
     * proof caught it — a fixture that starts node with no probe, directly after a django block
     * that has one, was accepted. In the real script the blocks are far enough apart that the
     * loose rule gave the right answer, which is the worst way for a rule to be wrong.
     *
     * A probe belongs to the block that started the plane, so the scan runs forward from the
     * start line and stops as soon as another plane's directory appears.
     */
    for (let j = i; j < Math.min(lines.length, i + 25); j++) {
      const m = j > i && lines[j].match(OTHER_PLANE);
      if (m && !lines[j].includes(dir)) break;
      if (lines[j].includes("wait_for") || lines[j].includes("--wait"))
        return true;
    }
    return false;
  });
  if (!near)
    gaps.push(
      `dev-all.sh has no wait_for probe for "${id}". Without one the script would report the ` +
        `plane started because the START command returned, which is a different claim.`
    );

  // And a way to stop it. --down promises "everything this script starts".
  if (
    !new RegExp(
      `${dir}[^\\n]*docker compose down|docker compose down[^\\n]*${dir}`
    ).test(script) &&
    !new RegExp(`"${dir}:`).test(script)
  )
    gaps.push(
      `dev-all.sh can start ${dir} but never stops it. --down documents "stop everything this ` +
        `script starts", and a container left running behind a line that says it shut down is ` +
        `the same silence in the other direction.`
    );

  return gaps;
}

export function check(manifestText, script) {
  const runtimes = declaredRuntimes(manifestText);
  if (runtimes.size === 0)
    return [
      "TOTALITY: rungs.json declares ZERO runtimes, so 'every declared runtime is startable' " +
        "is true of none of them. The manifest moved or its shape changed.",
    ];
  return [...runtimes].sort().flatMap((id) => planeGaps(id, script));
}

function main() {
  const manifestPath = join(ROOT, "rungs.json");
  const scriptPath = join(ROOT, "scripts", "dev-all.sh");
  for (const [what, p] of [
    ["rungs.json", manifestPath],
    ["scripts/dev-all.sh", scriptPath],
  ])
    if (!existsSync(p)) {
      console.error(
        `REFUSING TO RUN: ${what} is absent, so the set of runtimes that ought to be startable ` +
          `cannot be computed. Exiting 2 — not checked is not the same as nothing missing.`
      );
      process.exit(2);
    }

  const problems = check(
    readFileSync(manifestPath, "utf8"),
    readFileSync(scriptPath, "utf8")
  );
  if (problems.length) {
    console.error(
      `\nFAIL: ${problems.length} gap(s) between the runtimes rungs.json declares and what\n` +
        `      pnpm dev can actually bring up.\n`
    );
    for (const p of problems) console.error(`  · ${p}\n`);
    process.exit(1);
  }
  const ids = [...declaredRuntimes(readFileSync(manifestPath, "utf8"))].sort();
  reportSubject(ids.length, "runtime(s) declared");
  console.log(
    `PASS: all ${ids.length} runtime(s) rungs.json declares (${ids.join(
      ", "
    )}) can be asked\n` +
      `      for from scripts/dev-all.sh, are probed before it reports them ready, and are\n` +
      `      torn down by --down.`
  );
}

// #631's shared guard, which has now landed. This file carried the resolved-both-sides
// comparison inline so it could go out independently of that branch; the promise in the note
// it replaced was that this becomes a one-line switch once #631 was on main, and it is.
if (invokedAsProgram(import.meta.url)) main();
