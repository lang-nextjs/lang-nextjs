/**
 * PROOF for assert-bot-silence-is-classified.mjs (#810).
 *
 * The verdicts are pure functions over fabricated config and PR lists, so every arm is driven
 * without a board that happens to be in the right state. The two refusals are driven by a `gh`
 * shim earlier on PATH, because "could not ask" is a process-level property and an unread board
 * and an empty one produce the same count.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ecosystems,
  countBySlug,
  SLUGS,
} from "./assert-bot-silence-is-classified.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const ok = (name, cond, detail) => results.push({ ok: !!cond, name, detail });

/* ── parsing the config ─────────────────────────────────────────────────── */
const YAML = [
  "version: 2",
  "updates:",
  "  - package-ecosystem: npm",
  "    directory: /",
  "    open-pull-requests-limit: 10",
  "  - package-ecosystem: github-actions",
  "    directory: /",
  "# open-pull-requests-limit: 99",
  "",
].join("\n");
const parsed = ecosystems(YAML);
ok(
  "both ecosystems are parsed with their declared limits",
  parsed.length === 2 && parsed[0].name === "npm" && parsed[0].limit === 10,
  JSON.stringify(parsed)
);
ok(
  "an ecosystem with NO declared limit takes Dependabot's default of 5, marked as inherited",
  parsed[1].name === "github-actions" &&
    parsed[1].limit === 5 &&
    parsed[1].declared === false,
  JSON.stringify(parsed[1])
);
ok(
  "a limit inside a COMMENT is not read as a declaration",
  parsed[1].limit !== 99,
  "a commented-out limit was parsed as real"
);
ok(
  "a config declaring no ecosystem yields none, so the checker can refuse rather than pass",
  ecosystems("version: 2\nupdates:\n").length === 0,
  "invented an ecosystem"
);

/* ── counting open PRs ──────────────────────────────────────────────────── */
const PRS = [
  {
    author: { login: "dependabot[bot]" },
    headRefName: "dependabot/npm_and_yarn/a-1.0.0",
  },
  {
    author: { login: "dependabot[bot]" },
    headRefName: "dependabot/npm_and_yarn/b-2.0.0",
  },
  {
    author: { login: "dependabot[bot]" },
    headRefName: "dependabot/github_actions/c-3",
  },
  {
    author: { login: "a-human" },
    headRefName: "dependabot/npm_and_yarn/not-a-bot-pr",
  },
  { author: { login: "dependabot[bot]" }, headRefName: "some/other/branch" },
];
const counted = countBySlug(PRS);
ok(
  "PRs are grouped by the ecosystem slug in the branch name",
  counted.byslug.get("npm_and_yarn") === 2 &&
    counted.byslug.get("github_actions") === 1,
  JSON.stringify([...counted.byslug])
);
ok(
  "a HUMAN's PR on a dependabot-shaped branch is NOT counted — the companion, since the " +
    "branch name alone would have accepted it",
  counted.byslug.get("npm_and_yarn") !== 3,
  "a human PR was counted toward the bot's limit"
);
ok(
  "a bot PR with no `dependabot/<slug>/` prefix is reported, not silently dropped",
  counted.unmatched.length === 1 &&
    counted.unmatched[0] === "some/other/branch",
  JSON.stringify(counted.unmatched)
);
ok(
  "an empty board yields empty counts rather than throwing",
  countBySlug([]).byslug.size === 0 &&
    countBySlug(undefined).unmatched.length === 0,
  "threw or invented a count"
);

/* ── the map must cover the config that ships ───────────────────────────── */
{
  const real = ecosystems(
    readFileSync(join(ROOT_DIR, ".github/dependabot.yml"), "utf8")
  );
  const missing = real.filter((e) => !SLUGS[e.name]).map((e) => e.name);
  ok(
    "every ecosystem in the SHIPPED dependabot.yml has a branch slug — without one its count " +
      "reads 0, which is exactly the healthy-looking silence this check exists to disambiguate",
    missing.length === 0,
    `unmapped: ${missing.join(", ")}`
  );
  ok(
    "...and the shipped config declares at least one ecosystem, so that case is not vacuous",
    real.length > 0,
    "the shipped config parsed to nothing, so the case above asserted nothing"
  );
}

/* ── the refusals: an unread board is not an empty one ──────────────────── */
{
  const CHECKER = join(
    ROOT_DIR,
    "scripts",
    "assert-bot-silence-is-classified.mjs"
  );
  const shimDir = mkdtempSync(join(tmpdir(), "bsc-shim-"));
  const shim = join(shimDir, "gh");
  const run = () =>
    spawnSync(process.execPath, [CHECKER], {
      encoding: "utf8",
      env: { ...process.env, PATH: shimDir + ":" + process.env.PATH },
    });

  writeFileSync(shim, ["#!/bin/sh", "exit 4", ""].join("\n"));
  chmodSync(shim, 0o755);
  const failed = run();
  ok(
    "a board that cannot be reached REFUSES (exit 2), not a report of zero open PRs",
    failed.status === 2,
    `exited ${failed.status}`
  );
  ok(
    "...and says `gh` RAN AND FAILED rather than that it is missing — #851's conflation one " +
      "level finer, watched being wrong during a real GraphQL throttle",
    /RAN and exited non-zero/.test(failed.stderr) &&
      !/not installed/.test(failed.stderr),
    failed.stderr.slice(0, 200)
  );

  const nodeDir = dirname(process.execPath);
  const absent = spawnSync(process.execPath, [CHECKER], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${nodeDir}:/usr/bin:/bin` },
  });
  ok(
    "an ABSENT `gh` refuses with the OTHER message — the two spawn-side failures are told " +
      "apart, so a reader is not sent to check an installation that is fine",
    absent.status === 2 &&
      /not installed or is not on PATH/.test(absent.stderr) &&
      !/RAN and exited/.test(absent.stderr),
    absent.stderr.slice(0, 200)
  );

  writeFileSync(shim, ["#!/bin/sh", "printf 'not json'", "exit 0"].join("\n"));
  chmodSync(shim, 0o755);
  const garbage = run();
  ok(
    "`gh` printing non-JSON is DISTINGUISHED from `gh` failing (#851) — it RAN, and that " +
      "sends a reader somewhere different",
    garbage.status === 2 &&
      /is not JSON/.test(garbage.stderr) &&
      !/did not run/.test(garbage.stderr),
    garbage.stderr.slice(0, 200)
  );
  rmSync(shimDir, { recursive: true, force: true });
}

/* ── report ─────────────────────────────────────────────────────────────── */
let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`
  );
}
const pass = results.filter((r) => r.ok).length;
const EXPECTED = 14; // 12 + 2 for the spawn-side split

process.on("exit", (code) => {
  const ran = results.length;
  if (code === 0 && printed !== ran) {
    console.error(
      `\nFAIL: ${ran} case(s) ran and ${printed} printed — ${
        ran - printed
      } INVISIBLE (#881).`
    );
    process.exitCode = 1;
  }
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `\nFAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});

if (pass !== results.length) {
  console.error(`\nFAIL: ${results.length - pass}/${results.length} wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${results.length}. Capacity is compared per ecosystem, a human's PR on a\n` +
    `      bot-shaped branch is excluded, and an unread board refuses rather than reporting zero.`
);
