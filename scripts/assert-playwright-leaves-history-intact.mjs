#!/usr/bin/env node
/**
 * Property: RUNNING PLAYWRIGHT UNDER CI DOES NOT SHALLOW-FLAG THE WORKSPACE.
 *
 * `captureGitInfo.diff` defaults to ON whenever Playwright detects CI. Its gitCommitInfo
 * plugin then runs, against whatever repository the config resolves inside:
 *
 *     git fetch origin ${pull_request.base.sha} --depth=1 …
 *
 * which writes `$GIT_DIR/shallow` holding exactly that sha. Git grafts a shallow boundary
 * PARENTLESS, so a later walk from the PR base sees ONE commit and EVERY FILE READS AS "ADDED
 * THERE". That boundary is the exact base a revert detector compares against -- which is how
 * #427's checker refused on every PR for four rounds while nobody could say why (#470).
 *
 * ── WHY THIS ASSERTS BEHAVIOUR AND NOT THE FLAG ───────────────────────────────────────────
 *
 * The fix is one line in playwright.config.ts. Reading that line back would prove only that
 * the line is still there: an option RENAMED or RE-DEFAULTED by a later Playwright is silently
 * ignored, and the config would still read correct while the fetch resumed. So this drives the
 * REAL config through the REAL Playwright binary with a CI event payload, and asks git.
 *
 * ── IT MUST NOT ASSERT "THE WORKSPACE IS NOT SHALLOW" ─────────────────────────────────────
 *
 * `actions/checkout` defaults to `fetch-depth: 1`, so a job's workspace is often LEGITIMATELY
 * shallow and such a check would be red on jobs that are fine. The property is narrower and
 * exact: running Playwright must not CREATE that flag where there was none.
 *
 * ── AND IT MUST NOT RUN IN A WORKTREE ─────────────────────────────────────────────────────
 *
 * A `--depth` fetch from a git worktree writes the SHARED `.git/shallow` and would flag the
 * parent repository -- the checker inflicting the defect it exists to detect. The probe
 * therefore runs in a throwaway repo with its OWN `.git`, and verifies that afterwards.
 *
 * ── WHAT IT DOES NOT COVER ────────────────────────────────────────────────────────────────
 *
 * EVERY `playwright.config.*` IN THE TREE IS ACCOUNTED FOR (#480), and they are not all
 * accounted for the same way, because we do not own them all.
 *
 *   OWNED     probed behaviourally, and REQUIRED to leave history intact. A second owned
 *             config added later is probed too, without anyone editing this file.
 *   VENDORED  DECLARED, not required. `rungs/5-software-developer-agent` is upstream's tree
 *             carried rather than authored (`reach: vendored`, #424), and patching it would
 *             create a divergence to re-apply on every sync -- the drift #454 already tracks.
 *
 * A vendored config is not probed for a second reason worth stating: rung 5's declares a
 * `webServer` running `npm run start`, so a behavioural probe would try to boot upstream's app.
 * The check on it is therefore STATIC and says so, rather than quietly asserting less than it
 * appears to.
 *
 * WHY DECLARING IS NOT THE SAME AS IGNORING. The exposure is real for the one audience this
 * repository exists for -- someone forking rung 5 and running its suite in CI -- and it is
 * invisible from main, because no cell here runs that config. Recording it makes a forker meet
 * the hazard named rather than discover it. And the record cannot rot: a vendored config that
 * gains the fix upstream makes its entry STALE and fails, and a NEW vendored config nobody has
 * examined fails on arrival.
 *
 * Usage: node scripts/assert-playwright-leaves-history-intact.mjs [--cwd DIR] [--config PATH]
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  statSync,
  rmSync,
  symlinkSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const ROOT = resolve(
  argOf("--cwd") ?? join(dirname(fileURLToPath(import.meta.url)), "..")
);
const CONFIG = resolve(argOf("--config") ?? join(ROOT, "playwright.config.ts"));

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * Run the real Playwright binary against `configPath` inside a throwaway repo, with an
 * environment that makes Playwright believe it is CI on a pull_request.
 *
 * Returns what git says afterwards, plus everything needed to see WHICH repo was examined --
 * a probe that cannot say what it looked at cannot be distinguished from one that looked at
 * the wrong thing.
 */
export function probe({ root = ROOT, configPath = CONFIG } = {}) {
  const bin = join(root, "node_modules", ".bin", "playwright");
  const modules = join(root, "node_modules");
  if (!existsSync(bin))
    return { ran: false, reason: `no playwright binary at ${bin}` };
  if (!existsSync(configPath))
    return { ran: false, reason: `no config at ${configPath}` };

  const dir = mkdtempSync(join(tmpdir(), "pw-hist-"));
  try {
    // A REPO OF ITS OWN, never a worktree of this one.
    git(dir, "init", "--quiet");
    git(dir, "config", "user.email", "probe@example.invalid");
    git(dir, "config", "user.name", "probe");
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    git(dir, "add", "seed.txt");
    git(dir, "commit", "--quiet", "-m", "seed");
    // `origin` is this repository, so the base sha below is genuinely fetchable -- which is
    // what makes the depth-fetch reach the code path rather than fail early and look clean.
    git(dir, "remote", "add", "origin", root);

    const baseSha = git(root, "rev-parse", "HEAD");
    writeFileSync(
      join(dir, "event.json"),
      JSON.stringify({
        pull_request: { base: { sha: baseSha }, head: { sha: baseSha } },
      })
    );
    copyFileSync(configPath, join(dir, "playwright.config.ts"));
    mkdirSync(join(dir, "e2e"), { recursive: true });
    symlinkSync(modules, join(dir, "node_modules"));

    const shallow = join(dir, ".git", "shallow");
    let exitCode = 0;
    try {
      execFileSync(bin, ["test", "--grep=ZZZ_NO_TEST_MATCHES_THIS"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: join(dir, "event.json"),
        },
      });
    } catch (e) {
      // EXPECTED: "No tests found" exits 1. Measured: the plugin has ALREADY run by then and
      // the file is already written, so a non-zero exit is not evidence of safety.
      exitCode = e.status ?? 1;
    }

    const present = existsSync(shallow);
    return {
      ran: true,
      probeRepo: dir,
      configExamined: relative(root, configPath) || configPath,
      baseSha,
      playwrightExit: exitCode,
      shallowPresent: present,
      shallowBytes: present ? statSync(shallow).size : 0,
      shallowContents: present ? readFileSync(shallow, "utf8").trim() : null,
      isShallow: git(dir, "rev-parse", "--is-shallow-repository"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Vendored configs already examined, and what was found. NOT a suppression list.
 *
 * `exposed: true` records that the file sets no `captureGitInfo`, so an ejected fork running it
 * meets the full #470 mechanism. The staleness check below is what keeps this honest: if
 * upstream sets the flag, the entry no longer describes the file and this fails asking for its
 * removal. The list can only shrink, and a vendored config that is not in it at all fails as
 * unexamined.
 */
const VENDORED_KNOWN = {
  "rungs/5-software-developer-agent/apps/open-swe/playwright.config.ts": {
    exposed: true,
  },
};

/**
 * The vendored half of the census, as a pure function so it can be proven without Playwright.
 *
 * WHAT WAS ALREADY RIGHT HERE, because it is worth not undoing: a vendored config absent from
 * VENDORED_KNOWN already fails as unexamined, and the walk DISCOVERS configs rather than naming
 * them — so "someone vendors a new playwright config" was caught before this change. Two things
 * were not.
 *
 * ONE: an entry whose config no longer exists was never visited. The loop iterates over configs
 * FOUND IN THE TREE, so a record for a deleted or ejected config is unreachable and therefore
 * never questioned. It reads to the next person as a considered decision about a live file.
 *
 * TWO, and this is the one that printed a falsehood: `exposed` was read as a truthy flag with
 * no domain. An entry of `{ exposed: false }` — or `{}` after a typo — took neither the
 * unexamined branch nor the stale branch, and landed in the else, which announces "DECLARED
 * EXPOSED — sets no captureGitInfo" about a file that may plainly set it. Measured: with
 * `{ exposed: false }` against a config containing `captureGitInfo: { commit: false, diff:
 * false }`, the census printed exactly that line. The summary asserted a property that branch
 * never checked, which is the defect this whole issue is about, sitting inside the checker.
 */
export function vendoredCensus(configs, read, known) {
  const problems = [];
  const lines = [];

  for (const rel of configs) {
    const entry = known[rel];
    const text = read(rel);
    if (text === null) {
      problems.push(
        `vendored config ${rel} was discovered by the walk and could not then be read. That is ` +
          `a race or a permission problem, not an absence — it must not be recorded as either ` +
          `examined or exposed.`
      );
      continue;
    }
    const disabled = declaresCaptureDisabled(text);

    if (!entry) {
      problems.push(
        `vendored config ${rel} has never been examined. Add it to VENDORED_KNOWN with what ` +
          `it declares, so a forker meets the hazard named rather than discovering it.`
      );
      continue;
    }
    // THE FIELD MUST MEAN SOMETHING. `exposed` is the entry's only claim; anything but a
    // literal true or false leaves the line below asserting a state nobody recorded.
    if (typeof entry.exposed !== "boolean") {
      problems.push(
        `MALFORMED RECORD: ${rel}'s VENDORED_KNOWN entry has exposed=${JSON.stringify(
          entry.exposed
        )}, which is not a boolean. The census line for a vendored config states what it ` +
          `declares, and with no usable claim it would state it anyway — from nothing.`
      );
      continue;
    }
    // The record and the file must agree, in BOTH directions. Previously only the
    // exposed-but-now-disabled direction was checked.
    if (entry.exposed && disabled)
      problems.push(
        `STALE RECORD: ${rel} now disables git capture, so it is no longer exposed — delete ` +
          `its VENDORED_KNOWN entry. A record that no longer describes the file is a mute button.`
      );
    else if (!entry.exposed && !disabled)
      problems.push(
        `STALE RECORD: ${rel} is recorded as NOT exposed, and it sets no captureGitInfo that ` +
          `this checker can find — so it is exposed. An ejected fork running it meets #470 in ` +
          `full while this census says it does not.`
      );
    else if (entry.exposed)
      lines.push(
        `  vendored  ${rel}  DECLARED EXPOSED — sets no captureGitInfo; not probed (static), ` +
          `not patched (upstream's tree)`
      );
    else
      lines.push(
        `  vendored  ${rel}  declares captureGitInfo disabled — not a #470 exposure`
      );
  }

  /*
   * A RECORD FOR A CONFIG THAT IS GONE. Unreachable from the loop above, because that walks the
   * tree and this entry's file is not in it. Ejecting a rung deletes its configs and leaves the
   * entry behind, where it reads as a live decision about a live file.
   */
  const present = new Set(configs);
  for (const rel of Object.keys(known))
    if (!present.has(rel))
      problems.push(
        `STALE RECORD: VENDORED_KNOWN names ${rel}, which no walk of this tree finds. Either ` +
          `the config was deleted, the rung was ejected, or it moved — and until someone says ` +
          `which, this list describes a tree that no longer exists.`
      );

  return { problems, lines };
}

/** Every Playwright config in the tree, repo-relative, excluding installed and built trees. */
export function playwrightConfigs(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (
        name === "node_modules" ||
        name === ".next" ||
        name === ".git" ||
        name === "dist"
      )
        continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/^playwright\.config\.[cm]?[jt]s$/.test(name))
        out.push(relative(root, abs));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Ours to fix, or upstream's to carry.
 *
 * Keyed on the rungs/ prefix rather than on a filename list, so a vendored tree added later is
 * classified without anyone remembering to add it here.
 */
export const isVendored = (rel) => rel.startsWith("rungs/");

/** Does a vendored config disable git capture? Static, deliberately — see SCOPE above. */
export function declaresCaptureDisabled(text) {
  return /captureGitInfo\s*:\s*\{[^}]*\bdiff\s*:\s*false/.test(text);
}

function main() {
  const r = probe();

  /*
   * POSITIVE CONTROL. "Playwright left history intact" and "I never managed to run Playwright"
   * print the same green, and the second is what happens before an install or after a rename.
   * Nothing examined is not nothing wrong.
   */
  if (!r.ran) {
    console.error(
      `FAIL: could not run the probe — ${r.reason}.\n` +
        `      This checker is about what Playwright does when it runs, so not running it means ` +
        `it\n      COULD NOT COMPUTE the property — not that the property holds.`
    );
    process.exit(2);
  }

  // NAME THE SUBJECT: which config, which repo, what git said. A checker that looked at the
  // wrong repository must not be able to report success.
  console.log(
    `  config examined : ${r.configExamined}\n` +
      `  probe repo      : own .git, seeded, origin -> ${ROOT}\n` +
      `  PR base sha     : ${r.baseSha}\n` +
      `  playwright exit : ${r.playwrightExit} (non-zero is expected: no test matches)\n` +
      `  .git/shallow    : ${
        r.shallowPresent
          ? `PRESENT, ${r.shallowBytes} bytes, ${r.shallowContents}`
          : "absent"
      }\n` +
      `  is-shallow-repo : ${r.isShallow}`
  );

  if (r.shallowPresent) {
    console.error(
      `\nFAIL: running Playwright against ${r.configExamined} shallow-flagged the repository it ` +
        `ran in.\n` +
        `      $GIT_DIR/shallow now holds ${r.shallowContents}, which is the PR base. Git grafts ` +
        `that\n      boundary parentless, so every later history read sees one commit and every ` +
        `file as\n      added there — silently, in whatever tool runs next.\n` +
        `      Set \`captureGitInfo: { commit: false, diff: false }\` in that config. If it is ` +
        `already\n      set, the option has been renamed or re-defaulted upstream and the fix ` +
        `is no longer\n      being honoured — which is exactly why this asserts behaviour ` +
        `rather than the flag.`
    );
    process.exit(1);
  }

  // ── EVERY CONFIG IN THE TREE IS ACCOUNTED FOR (#480) ──────────────────────────────────
  const configs = playwrightConfigs();
  if (configs.length === 0) {
    console.error(
      `FAIL: found no playwright.config.* anywhere under ${ROOT}.\n` +
        `      The probe above examined one file by name, so this reports on a set it could not\n` +
        `      build — nothing examined is not nothing wrong.`
    );
    process.exit(2);
  }

  const problems = [];
  const lines = [];
  for (const rel of configs) {
    if (isVendored(rel)) continue; // handled below, by the census

    // Ours. The named config was probed above; any OTHER owned config must be probed too,
    // or "we check our configs" would mean "we check the one we thought of".
    if (resolve(ROOT, rel) === CONFIG) {
      lines.push(`  owned     ${rel}  probed above — history intact`);
      continue;
    }
    const extra = probe({ root: ROOT, configPath: resolve(ROOT, rel) });
    if (!extra.ran)
      problems.push(`could not probe owned config ${rel}: ${extra.reason}`);
    else if (extra.shallowPresent)
      problems.push(`owned config ${rel} shallow-flagged the repo`);
    else lines.push(`  owned     ${rel}  probed — history intact`);
  }

  // The vendored half, including the records whose files the walk never reached.
  {
    const vendored = configs.filter(isVendored);
    const read = (rel) => {
      const abs = resolve(ROOT, rel);
      return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    };
    const census = vendoredCensus(vendored, read, VENDORED_KNOWN);
    problems.push(...census.problems);
    lines.push(...census.lines);
  }

  if (problems.length) {
    console.error("\nFAIL: the Playwright config census does not hold:\n");
    for (const p of problems) console.error("  - " + p + "\n");
    process.exit(1);
  }

  reportSubject(configs.length, "playwright config(s)");
  console.log(
    `\nPASS: Playwright ran under a CI pull_request environment and left no shallow boundary.\n\n` +
      `Playwright configs in this tree (${configs.length}):\n` +
      lines.join("\n") +
      `\n\nNOTE: a DECLARED vendored config is a KNOWN EXPOSURE, not a guarded one. An ejected\n` +
      `      fork that runs it meets #470 in full. This proves the exposure is recorded, never\n` +
      `      that it is closed.`
  );
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
