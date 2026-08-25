#!/usr/bin/env node
/**
 * Proves check-langfuse-wiring.mjs fails on an unwired site, a DELETED site, a
 * missing source file, and a subject-less run — and passes on a correct tree.
 *
 * CI runs this immediately BEFORE the real check (#116: every checker CI runs
 * must have a proof CI runs). A checker never observed to fail is
 * indistinguishable from one that cannot fail.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWiring, checkLockstep, checkNoSecretLiterals } from "./check-langfuse-wiring.mjs";

const REAL = process.argv[2] || process.cwd();
const RT = ["apps/fastapi-backend/ai_backends",
            "apps/django-backend/deepagents_backend/ai_backends"];
const FIX = ["scripts/langfuse-local/docker-compose.yml",
             "scripts/langfuse-local/backend-override.yml"];
const REQ = ["apps/fastapi-backend/requirements.txt",
             "apps/django-backend/requirements.txt"];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lfwire-"));
  for (const rt of RT) {
    mkdirSync(join(dir, rt), { recursive: true });
    cpSync(join(REAL, rt, "deepagents.py"), join(dir, rt, "deepagents.py"));
    cpSync(join(REAL, rt, "langgraph.py"), join(dir, rt, "langgraph.py"));
    cpSync(join(REAL, rt, "langchain.py"), join(dir, rt, "langchain.py"));
    cpSync(join(REAL, rt, "_common.py"), join(dir, rt, "_common.py"));
  }
  mkdirSync(join(dir, "scripts/langfuse-local"), { recursive: true });
  for (const f of FIX) cpSync(join(REAL, f), join(dir, f));
  for (const r of REQ) {
    mkdirSync(join(dir, r.replace(/\/requirements\.txt$/, "")), { recursive: true });
    cpSync(join(REAL, r), join(dir, r));
  }
  return dir;
}

let pass = 0, total = 0;
const expect = (want, label, fn) => {
  total++;
  const dir = fixture();
  try {
    fn(dir);
    const { problems } = checkWiring(dir);
    const failed = [...problems, ...checkLockstep(dir), ...checkNoSecretLiterals(dir)].length > 0;
    if (failed === want) { pass++; console.log(`  ok   ${label.padEnd(52)} (${failed ? "rejected" : "accepted"})`); }
    else console.log(`  FAIL ${label.padEnd(52)} (${failed ? "rejected" : "accepted"}, wanted ${want ? "rejected" : "accepted"})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

expect(false, "an unmodified tree is accepted", () => {});

expect(true, "a site with config= stripped is rejected", (d) => {
  const f = join(d, RT[0], "langgraph.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace(", config=langfuse_config()", ""));
});

expect(true, "THE ORPHAN (langchain planner) unwired is rejected", (d) => {
  const f = join(d, RT[0], "langchain.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace('planner.ainvoke({"input": user_text}, config=langfuse_config())',
                               'planner.ainvoke({"input": user_text})'));
});

expect(true, "a DELETED site is rejected (count is pinned)", (d) => {
  const f = join(d, RT[0], "langgraph.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace(/async for event in graph\.astream_events\([\s\S]*?\):/, "if True:"));
});

expect(true, "a MISSING source file is rejected, not skipped", (d) => {
  rmSync(join(d, RT[1], "langchain.py"));
});

expect(true, "an empty tree is rejected (zero subjects is vacuous)", (d) => {
  for (const rt of RT) rmSync(join(d, rt), { recursive: true, force: true });
});

expect(true, "DRIFTED _common.py is rejected", (d) => {
  const f = join(d, RT[1], "_common.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace("def langfuse_configured()", "def langfuse_configured_DRIFTED()"));
});

expect(true, "anchor missing in BOTH is rejected (would compare two empty spans)", (d) => {
  for (const rt of RT) {
    const f = join(d, rt, "_common.py");
    writeFileSync(f, readFileSync(f, "utf8").replace("def make_llm", "def make_llm_RENAMED"));
  }
});

expect(true, "a differing langfuse pin is rejected", (d) => {
  const f = join(d, REQ[1]);
  writeFileSync(f, readFileSync(f, "utf8").replace(/^langfuse.*$/m, "langfuse>=2,<3"));
});

expect(true, "langfuse absent from BOTH requirements is rejected (not 'they match')", (d) => {
  for (const r of REQ) {
    const f = join(d, r);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^langfuse.*$/m, ""));
  }
});

expect(true, "a re-committed 64-hex key in the fixture is rejected", (d) => {
  const f = join(d, FIX[0]);
  writeFileSync(f, readFileSync(f, "utf8").replace(/\$\{ENCRYPTION_KEY[^}]*\}/,
    "bdd9df36aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff2233445566"));
});

expect(false, "the LOW-entropy labelled fixture values are NOT flagged", () => {});

console.log();
if (pass === total) {
  console.log(`PASS: ${pass}/${total}. check-langfuse-wiring.mjs has been observed to fail on`);
  console.log(`      unwired, deleted, missing, drifted and subject-less input — including the`);
  console.log(`      two cases where BOTH sides are absent and "they match" would be vacuous.`);
  process.exit(0);
}
console.log(`FAIL: ${pass}/${total}`);
process.exit(1);
