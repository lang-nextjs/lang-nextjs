#!/usr/bin/env node
/*
 * TYPECHECK e2e/, AND SAY SO — because turbo's summary cannot.
 *
 * `pnpm typecheck` is `turbo typecheck && pnpm typecheck:e2e`. Turbo runs each
 * WORKSPACE package's own script, and the workspaces are `packages/*` and
 * `apps/*`. e2e/ is neither, so turbo does not know it exists and its summary
 * line reads:
 *
 *     Tasks:    20 successful, 20 total
 *
 * That line is TRUE and INCOMPLETE. It was true before #674 too, when e2e/ was
 * typechecked by nothing at all — a planted `const x: number = "nope"` produced
 * exactly that summary and exit 0. #674 made the command exit 2 on such an
 * error, but left the summary saying 20/20, so a reader who stops at the task
 * count still sees what they saw before the fix.
 *
 * This script closes that: on success it names its own subject and the file
 * count, so the LAST line of a green run says e2e/ was examined and how much of
 * it. A checker that does not report what it looked at is one this repo has
 * been removing all week; leaving the gap open in the fix for that same class
 * would have been the joke telling itself.
 *
 * NOT a checks.json entry, so no proof is paired with it: it is a build script
 * that shells to tsc, and its verdict is tsc's. Five other scripts here are
 * unpaired for the same reason (attach-owner, gen-rung-types, has-rung,
 * readme-quickstart, validate-manifest).
 *
 * Exit codes are tsc's, passed through unchanged: 0 clean, non-zero otherwise.
 * This script adds a line on success and nothing on failure — tsc's own
 * diagnostics are the report there, and prefixing them would bury the file and
 * line a reader needs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CONFIG = "e2e/tsconfig.json";

function countTs(dir) {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) n += countTs(p);
    else if (entry.endsWith(".ts")) n += 1;
  }
  return n;
}

/*
 * Resolved from node_modules rather than through `npx`, which prints npm's
 * update notices into the middle of a typecheck's output. The binary is a
 * declared devDependency, so if it is absent the tree is not installed and
 * saying that is more useful than letting npx fetch some other version.
 */
const TSC = join("node_modules", ".bin", "tsc");
if (!existsSync(TSC)) {
  console.error(
    `FAIL: ${TSC} is absent, so e2e/ COULD NOT BE TYPECHECKED. Run \`pnpm install\` first.\n` +
      `      This is not a clean tree — it is an unbuilt one, and the two must not read alike.`
  );
  process.exit(2);
}

const tsc = spawnSync(TSC, ["-p", CONFIG], { stdio: "inherit" });

if (tsc.status !== 0) process.exit(tsc.status ?? 1);

/*
 * The count is derived from the tree rather than written down, so it cannot
 * drift the way a hardcoded number would. It is the file count the config's
 * `include` covers, not a claim that every one is error-free beyond what tsc
 * just said.
 */
console.log(
  `PASS: ${countTs(
    "e2e"
  )} TypeScript file(s) in e2e/ typechecked via ${CONFIG}.\n` +
    `      Turbo's task count above EXCLUDES these — e2e/ is not a workspace package,\n` +
    `      so "N successful, N total" describes packages/* and apps/* only.`
);
