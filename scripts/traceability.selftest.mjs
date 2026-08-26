#!/usr/bin/env node
/**
 * Selftest for traceability.mjs.
 *
 * Plants each defect the checker claims to catch, in a throwaway copy, and asserts a NON-ZERO
 * exit. Every case also asserts the mutation ACTUALLY LANDED before running the checker — a
 * mutation that silently fails to apply proves nothing, and this repo has been bitten by that
 * more than once.
 *
 * The cases that matter most are the two vacuity ones. A link checker that validates only the
 * rows which happen to carry a citation passes cleanly on a file with zero citations, and a
 * parse that matches nothing passes on everything. Either would ship as a decoration.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CHECKER = join(HERE, "traceability.mjs");
const PROJECT_REL = ".planning/PROJECT.md";

let failures = 0;
const ok = (n) => console.log(`  PASS  ${n}`);
const bad = (n, why) => { console.error(`  FAIL  ${n}\n        ${why}`); failures += 1; };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trace-"));
  mkdirSync(join(root, ".planning"), { recursive: true });
  cpSync(join(REPO, PROJECT_REL), join(root, PROJECT_REL));
  return root;
}
function run(root) {
  try {
    execFileSync("node", [CHECKER, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}
function withFixture(name, mutate, expect) {
  const root = fixture();
  try {
    if (mutate(root) === false) return bad(name, "MUTATION DID NOT APPLY — the case proves nothing");
    const { code, out } = run(root);
    if (expect === "fail" && code === 0) return bad(name, "checker exited 0; it cannot detect this");
    if (expect === "pass" && code !== 0) return bad(name, `checker exited ${code}:\n${out}`);
    ok(name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const readP = (root) => readFileSync(join(root, PROJECT_REL), "utf8");
const writeP = (root, s) => writeFileSync(join(root, PROJECT_REL), s);

console.log("traceability selftest");

withFixture("the tree as it stands passes", () => true, "pass");

// ── TOTALITY: a NEW uncited ✓ row must fail, even though every existing row is allowlisted ──
withFixture(
  "a new uncited ✓ row FAILS (totality, not just present-citation validation)",
  (root) => {
    const s = readP(root);
    writeP(root, s + "\n- ✓ **NEW-99** — a claim nobody linked to a test — v9.9\n");
    return readP(root).includes("NEW-99");
  },
  "fail"
);

// ── a citation that points at nothing ───────────────────────────────────────────────────
withFixture(
  "a citation naming a file that does not exist FAILS",
  (root) => {
    const s = readP(root);
    writeP(root, s + '\n- ✓ **NEW-98** — x — v9.9 — verified by `packages/server/src/no-such-file.test.ts` "nope"\n');
    return readP(root).includes("no-such-file");
  },
  "fail"
);

// ── a citation to a real file that lacks the named test ─────────────────────────────────
withFixture(
  "a citation naming a test the file does NOT contain FAILS",
  (root) => {
    // Copy a real test file in so the path resolves and only the NAME is wrong. Without this
    // the case would pass for the wrong reason — a missing file, not a missing test.
    mkdirSync(join(root, "packages/server/src"), { recursive: true });
    cpSync(join(REPO, "packages/server/src/approval-registry.test.ts"),
           join(root, "packages/server/src/approval-registry.test.ts"));
    const s = readP(root);
    writeP(root, s + '\n- ✓ **NEW-97** — x — v9.9 — verified by `packages/server/src/approval-registry.test.ts` "a test name that is definitely not in there"\n');
    return readP(root).includes("NEW-97");
  },
  "fail"
);

// ── G1: a parse that matches nothing must not report success ────────────────────────────
withFixture(
  "an unparseable PROJECT.md FAILS rather than passing vacuously",
  (root) => {
    writeP(root, "# PROJECT\n\nno requirement rows here at all\n");
    return !readP(root).includes("✓");
  },
  "fail"
);

// ── G2: a NEW duplicate (not one of the two allowlisted) must be refused ────────────────
withFixture(
  "a newly duplicated id FAILS",
  (root) => {
    const s = readP(root);
    const line = s.split("\n").find((l) => l.startsWith("- ✓ **SRV-01**"));
    writeP(root, s + "\n" + line + "\n");
    return (readP(root).match(/\*\*SRV-01\*\*/g) || []).length === 2;
  },
  "fail"
);

// ── G3: a backfilled row makes its allowlist entry stale ────────────────────────────────
withFixture(
  "citing an allowlisted row makes its UNCITED entry STALE and FAILS",
  (root) => {
    // The delete-me property: the allowlist must shrink as rows are backfilled, and the
    // checker must say so rather than silently tolerating a now-unnecessary exemption.
    mkdirSync(join(root, "packages/server/src"), { recursive: true });
    cpSync(join(REPO, "packages/server/src/approval-registry.test.ts"),
           join(root, "packages/server/src/approval-registry.test.ts"));
    const name = readFileSync(join(REPO, "packages/server/src/approval-registry.test.ts"), "utf8")
      .match(/it\("([^"]{10,60})"/)?.[1];
    if (!name) return false;
    const s = readP(root);
    const out = s.replace(
      /^(- ✓ \*\*SRV-01\*\*.*)$/m,
      `$1 — verified by \`packages/server/src/approval-registry.test.ts\` "${name}"`
    );
    writeP(root, out);
    return out !== s;
  },
  "fail"
);

console.log(failures ? `\n${failures} case(s) FAILED` : "\nall selftest cases passed");
process.exit(failures ? 1 : 0);
