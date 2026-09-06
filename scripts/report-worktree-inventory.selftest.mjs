/**
 * PROOF for report-worktree-inventory.mjs (#826, #873).
 *
 * The verdicts are driven as PURE FUNCTIONS with fabricated worktree records, so every class is
 * exercised without a machine that happens to have one of each. The refusal is driven by a
 * `git` shim earlier on PATH, because an unreadable inventory is a PROCESS-LEVEL property and
 * an empty one and an unreadable one are the same output.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorktrees,
  isUnder,
  classify,
  bucketize,
  CLASSES,
} from "./report-worktree-inventory.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const ok = (name, cond, detail) => results.push({ ok: !!cond, name, detail });

/* ── parsing ────────────────────────────────────────────────────────────── */
const PORCELAIN = [
  "worktree /repo",
  "HEAD aaa",
  "branch refs/heads/main",
  "",
  "worktree /tmp/probe-x",
  "HEAD bbb",
  "detached",
  "",
].join("\n");
const parsed = parseWorktrees(PORCELAIN);
ok(
  "both blocks are parsed, with branch stripped to a short name",
  parsed.length === 2 && parsed[0].branch === "main" && parsed[0].path === "/repo",
  JSON.stringify(parsed)
);
ok(
  "a DETACHED worktree parses with branch null rather than being dropped",
  parsed[1].branch === null && parsed[1].head === "bbb",
  JSON.stringify(parsed[1])
);

/* ── #873: a path is compared as a path, never as a substring ───────────── */
ok(
  "a directory BENEATH the root is under it",
  isUnder("/a/b/c", "/a/b"),
  "beneath was reported as outside"
);
ok(
  "#873: a SIBLING SHARING A PREFIX is NOT under it — `/a/bc` vs `/a/b`, which is the " +
    "exact shape that made `eject-audit-` match a live branch",
  !isUnder("/a/bc", "/a/b"),
  "a prefix match was accepted as containment"
);
ok(
  "the root itself counts as under itself",
  isUnder("/a/b", "/a/b"),
  "a worktree AT the temp root would be missed"
);

/* ── classification ─────────────────────────────────────────────────────── */
const ctx = {
  tmp: "/scripttmp",
  remoteBranches: new Set(["feat/pushed"]),
  subjectOf: (sha) => (sha === "wipsha" ? "wip: scaffolding" : "fix: real work"),
};
ok(
  "a worktree under the script temp dir is proof-residue",
  classify({ path: "/scripttmp/probe-1", head: "x", branch: null }, ctx) ===
    "proof-residue",
  "not classified as residue"
);
ok(
  "a branch with a remote-tracking ref is pushed",
  classify({ path: "/work/a", head: "x", branch: "feat/pushed" }, ctx) === "pushed",
  "not classified as pushed"
);
ok(
  "a `wip:` HEAD subject is scaffold, asked about rather than judged",
  classify({ path: "/work/b", head: "wipsha", branch: "feat/local" }, ctx) ===
    "wip-scaffold",
  "not classified as scaffold"
);
ok(
  "everything else is NAMED, not judged",
  classify({ path: "/work/c", head: "x", branch: "feat/local" }, ctx) ===
    "named-unpushed",
  "not classified as named-unpushed"
);
ok(
  "residue OUTRANKS pushed — a probe directory is a probe whatever its branch",
  classify({ path: "/scripttmp/p", head: "x", branch: "feat/pushed" }, ctx) ===
    "proof-residue",
  "a pushed branch in a temp dir was reported as safe-because-pushed"
);

/* ── the reconciliation, which is the only thing that can fail ──────────── */
const wts = [{ path: "/a" }, { path: "/b" }];
const good = bucketize(wts, () => "pushed");
ok(
  "every worktree reaching a listed class leaves nothing unclassified (the companion)",
  good.unclassified.length === 0 && good.byClass.get("pushed").length === 2,
  JSON.stringify(good.unclassified)
);
const bad = bucketize(wts, () => "invented-class");
ok(
  "a class `classify` returns but `CLASSES` does not list is CAUGHT — otherwise those rows " +
    "vanish from every section while the total still reconciles",
  bad.unclassified.length === 2 && bad.unclassified[0].cls === "invented-class",
  JSON.stringify(bad.unclassified)
);
ok(
  "CLASSES is ordered safest-first, so rows needing no judgement are not buried",
  CLASSES[0] === "proof-residue" && CLASSES[CLASSES.length - 1] === "named-unpushed",
  CLASSES.join(",")
);

/* ── the refusal: an unreadable inventory is not an empty one ───────────── */
{
  const shimDir = mkdtempSync(join(tmpdir(), "wti-shim-"));
  const shim = join(shimDir, "git");
  writeFileSync(shim, ["#!/bin/sh", "exit 3", ""].join("\n"));
  chmodSync(shim, 0o755);
  const r = spawnSync(
    process.execPath,
    [join(ROOT_DIR, "scripts", "report-worktree-inventory.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: shimDir + ":" + process.env.PATH },
    }
  );
  ok(
    "an unreadable worktree list REFUSES (exit 2) rather than reporting an empty machine",
    r.status === 2,
    `exited ${r.status}`
  );
  ok(
    "...and NOT 0, which would report zero worktrees as a finding about the machine",
    r.status !== 0,
    "an unreadable inventory passed as an empty one"
  );
  rmSync(shimDir, { recursive: true, force: true });
}

/* ── report ─────────────────────────────────────────────────────────────── */
let printed = 0;
for (const r of results) {
  printed++;
  console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
}
const pass = results.filter((r) => r.ok).length;
const EXPECTED = 15;

process.on("exit", (code) => {
  const ran = results.length;
  if (code === 0 && printed !== ran) {
    console.error(
      `\nFAIL: ${ran} case(s) ran and ${printed} were printed — ${ran - printed} INVISIBLE (#881).`
    );
    process.exitCode = 1;
  }
  if (code === 0 && ran !== EXPECTED) {
    console.error(`\nFAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`);
    process.exitCode = 1;
  }
});

if (pass !== results.length) {
  console.error(`\nFAIL: ${results.length - pass}/${results.length} wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${results.length}. Paths are compared as paths, every class is driven, and\n` +
    `      an unreadable inventory refuses rather than reporting an empty machine.`
);
