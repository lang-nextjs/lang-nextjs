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
 * Only the config it names below. A second Playwright config added later and run in CI would
 * carry the same default and is not examined here. `rungs/5-software-developer-agent`'s
 * vendored config is one such file today: it sets no `captureGitInfo`, and nothing in this
 * repo's CI runs it -- but an ejected fork that does would be exposed.
 *
 * Usage: node scripts/assert-playwright-leaves-history-intact.mjs [--cwd DIR] [--config PATH]
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, statSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const ROOT = resolve(argOf("--cwd") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const CONFIG = resolve(argOf("--config") ?? join(ROOT, "playwright.config.ts"));

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
  if (!existsSync(bin)) return { ran: false, reason: `no playwright binary at ${bin}` };
  if (!existsSync(configPath)) return { ran: false, reason: `no config at ${configPath}` };

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
    writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: baseSha } } }));
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
      `  .git/shallow    : ${r.shallowPresent ? `PRESENT, ${r.shallowBytes} bytes, ${r.shallowContents}` : "absent"}\n` +
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

  console.log(
    `\nPASS: Playwright ran under a CI pull_request environment and left no shallow boundary.\n` +
      `      Only the config named above is covered; a second config added and run later would\n` +
      `      carry the same default and is not examined here.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
