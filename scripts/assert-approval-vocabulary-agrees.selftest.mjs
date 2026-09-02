#!/usr/bin/env node
/**
 * Proof for assert-approval-vocabulary-agrees.mjs.
 *
 * THE FIXTURES ARE THE DELIVERABLE, NOT A CHECK ON IT. Today every install this team has
 * measured at 1.3.x agrees with our parser, so the checker is green on a UNIFORM grid — and a
 * uniform grid means neither of its two claims has run. These cases are where they run.
 *
 * BOTH DIRECTIONS, BECAUSE THEY ARE DIFFERENT DEFECTS:
 *   widened  — upstream gains a decision our parser refuses. The card renders a button, the
 *              user clicks it, and we refuse the next request. FAILS.
 *   narrowed — upstream drops one we still accept. Reported, does NOT fail: the card renders
 *              only what the payload offers, so a user simply sees fewer controls.
 *
 * BOTH ARE EXERCISED HERE, with opposite expected verdicts, and that asymmetry is the point.
 * langchain 1.2.11 and 1.3.18 are BOTH compliant with `langchain>=0.3.0` and expand `True` to
 * three and four decisions respectively (#669) — so a checker that failed on narrowing would
 * fail on a safe install that exists on a developer machine today. Verified against all three
 * real installs: 1.2.11 green-with-a-note, 1.3.14 and 1.3.18 green.
 *
 * WHY STUB INTERPRETERS RATHER THAN REAL VENVS. The checker's job is to report what an
 * interpreter says, so the fixture controls what one says. A stub also lets the REFUSAL cases
 * exist at all — an interpreter that dies, or answers with something that is not JSON, has no
 * real-world venv to stand in for it. The residual gap is stated plainly at the bottom.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  cpSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "assert-approval-vocabulary-agrees.mjs");

let failures = 0;
let ran = 0;

function stubPython(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function speaks(decisions, version = "9.9.9") {
  const json = JSON.stringify({ ok: true, version, decisions });
  return `cat <<'JSON'\n${json}\nJSON`;
}

/** A tree with just the two files the checker reads, so a case can mutate one freely. */
function fixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), "vocab-"));
  for (const rel of [
    "apps/fastapi-backend/ai_backends/_common.py",
    "apps/fastapi-backend/ai_backends/langgraph.py",
  ]) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  return dir;
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, ...args], {
      encoding: "utf8",
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

function check(label, { args, wantCode, wantText }) {
  ran++;
  const { code, out } = run(args);
  const codeOk = code === wantCode;
  const textOk = !wantText || out.includes(wantText);
  if (codeOk && textOk) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}`);
  console.log(`        exit ${code}, wanted ${wantCode}`);
  if (!textOk) console.log(`        output did not contain: ${wantText}`);
  console.log(
    out
      .split("\n")
      .slice(0, 6)
      .map((l) => `        | ${l}`)
      .join("\n")
  );
}

console.log("assert-approval-vocabulary-agrees selftest");

const tree = fixtureTree();
const bin = mkdtempSync(join(tmpdir(), "vocab-bin-"));

// The parser's own vocabulary, read from the fixture, so these cases cannot drift from it.
const parserSrc = readFileSync(
  join(tree, "apps/fastapi-backend/ai_backends/_common.py"),
  "utf8"
);
const PARSER = [
  ...parserSrc
    .match(/^_DECISION_TYPES\s*=\s*\(([^)]*)\)/m)[1]
    .matchAll(/["']([a-z_]+)["']/g),
].map((m) => m[1]);
if (PARSER.length < 2) {
  console.log(
    `  FAIL  precondition: parser vocabulary parsed to ${JSON.stringify(
      PARSER
    )}`
  );
  process.exit(1);
}
console.log(`  (fixture parser vocabulary: ${JSON.stringify(PARSER)})`);

// ---- THE POSITIVE CONTROL. Without it, every case below passes against a checker that is
// simply always red, and a rejection-only suite cannot tell a working checker from that.
check("agreement is GREEN (positive control)", {
  args: ["--cwd", tree, "--python", stubPython(bin, "agrees", speaks(PARSER))],
  wantCode: 0,
  wantText: "approval vocabulary is compatible",
});

// ---- DIRECTION 1: upstream WIDENS.
check("upstream widening is caught, and names the new decision", {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(bin, "wide", speaks([...PARSER, "delegate"])),
  ],
  wantCode: 1,
  wantText: "UPSTREAM WIDENED",
});
check("...and the message names the offending decision, not just the fact", {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(bin, "wide2", speaks([...PARSER, "delegate"])),
  ],
  wantCode: 1,
  wantText: '["delegate"]',
});

// ---- DIRECTION 2: upstream NARROWS. The silent one.
const narrowed = PARSER.slice(0, -1);
const dropped = PARSER[PARSER.length - 1];
// A NARROWING DOES NOT FAIL, AND THAT IS THE DELIBERATE PART. langchain 1.2.11 is a real,
// `>=0.3.0`-compliant install that narrows (#669); failing on it would be a red on a SAFE
// configuration, and a red with an obvious one-line repair gets muted, taking the widening
// case with it. Measured harmless end to end: ApprovalPauseCard.tsx:90 renders only what the
// payload offers, and langgraph.py:110 does not use the middleware at all.
check(`upstream narrowing does NOT fail (drops ${dropped})`, {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(bin, "narrow", speaks(narrowed)),
  ],
  wantCode: 0,
  wantText: "NARROWED (not a failure)",
});
check("...but a narrowing is still REPORTED, naming what upstream dropped", {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(bin, "narrow2", speaks(narrowed)),
  ],
  wantCode: 0,
  wantText: JSON.stringify([dropped]),
});
// AND THE COMBINATION, because a real upstream change can do both at once and the harmful
// half must not be masked by the harmless one.
check("a simultaneous widening AND narrowing still FAILS on the widening", {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(bin, "both", speaks([...narrowed, "delegate"])),
  ],
  wantCode: 1,
  wantText: "UPSTREAM WIDENED",
});
check("...and that failure still reports the narrowing alongside it", {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(bin, "both2", speaks([...narrowed, "delegate"])),
  ],
  wantCode: 1,
  wantText: "NARROWED (not a failure)",
});

// ---- REFUSALS. "Could not determine" must never spell the same as "agrees".
check("an interpreter without langchain REFUSES (exit 2)", {
  args: [
    "--cwd",
    tree,
    "--python",
    stubPython(
      bin,
      "nolc",
      `cat <<'JSON'\n{"ok":false,"why":"import failed: ModuleNotFoundError"}\nJSON`
    ),
  ],
  wantCode: 2,
  wantText: "NOT a pass",
});
check("a non-JSON probe answer REFUSES rather than passing", {
  args: ["--cwd", tree, "--python", stubPython(bin, "junk", "echo not json")],
  wantCode: 2,
  wantText: "CANNOT BE COMPUTED",
});
check("an interpreter that dies REFUSES", {
  args: ["--cwd", tree, "--python", stubPython(bin, "dies", "exit 3")],
  wantCode: 2,
  wantText: "CANNOT BE COMPUTED",
});
check(
  "a probe reporting an EMPTY decision list REFUSES, it is not an empty agreement",
  {
    args: ["--cwd", tree, "--python", stubPython(bin, "empty", speaks([]))],
    wantCode: 2,
    wantText: "CANNOT BE COMPUTED",
  }
);
check("no interpreter at all REFUSES and NAMES every path it tried", {
  args: ["--cwd", tree, "--python", join(bin, "does-not-exist")],
  wantCode: 2,
  wantText: "Tried, in order:",
});

// ---- THE THIRD CLAIM: the authoring rung must keep DERIVING its offer.
const literalTree = fixtureTree();
const lgPath = join(
  literalTree,
  "apps/fastapi-backend/ai_backends/langgraph.py"
);
const lgSrc = readFileSync(lgPath, "utf8");
const mutated = lgSrc.replace(
  '"allowed_decisions": list(_DECISION_TYPES)',
  '"allowed_decisions": ["approve", "reject"]'
);
if (mutated === lgSrc) {
  failures++;
  ran++;
  console.log(
    "  FAIL  precondition: the langgraph offer anchor did not match — the mutation"
  );
  console.log(
    '        below would have tested nothing. Anchor: "allowed_decisions": list(_DECISION_TYPES)'
  );
} else {
  writeFileSync(lgPath, mutated);
  check("a hardcoded offer in the authoring rung is caught", {
    args: [
      "--cwd",
      literalTree,
      "--python",
      stubPython(bin, "ok2", speaks(PARSER)),
    ],
    wantCode: 1,
    wantText: "STOPPED DERIVING",
  });
}

// ---- The checker must refuse when its OWN subject is missing, rather than reporting agreement.
check("a tree with no _common.py REFUSES", {
  args: [
    "--cwd",
    mkdtempSync(join(tmpdir(), "vocab-empty-")),
    "--python",
    stubPython(bin, "ok3", speaks(PARSER)),
  ],
  wantCode: 2,
  wantText: "CANNOT BE COMPUTED",
});

console.log(`\n${ran - failures}/${ran} passed`);
if (failures) {
  console.log(
    "\nRESIDUAL GAP, STATED RATHER THAN PAPERED OVER: these cases drive stub interpreters, so\n" +
      "they prove the comparison and the refusals, NOT that the probe program works against a\n" +
      "real langchain. That half was verified by running the checker against three real installs\n" +
      "(1.2.11 -> red, 1.3.14 and 1.3.18 -> green) and is re-verified whenever the python job runs."
  );
  process.exit(1);
}
console.log(
  "RESIDUAL GAP: these cases drive stub interpreters, so they prove the comparison and the\n" +
    "refusals, not that the probe works against a real langchain. That half is covered by the\n" +
    "python CI job, which runs the checker against the installed requirements."
);
