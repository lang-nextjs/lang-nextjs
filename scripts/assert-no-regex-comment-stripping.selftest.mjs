#!/usr/bin/env node
/**
 * Proof for assert-no-regex-comment-stripping.mjs.
 *
 * THE ACCEPT CASE RUNS FIRST. A detector that flags everything looks identical to
 * one that flags the right things if you only ever run rejection cases, and this
 * repository has shipped that shape before.
 *
 * Exit 0 all pass, 1 on any failure.
 */
import { strippersIn } from "./assert-no-regex-comment-stripping.mjs";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0,
  fail = 0;
const ok = (name, cond) => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
};

const S = (src) => strippersIn(src, "f.mjs");

/* ---- 1. THE ACCEPT CASE ---------------------------------------------------- */

ok(
  "CONTROL: a file with no `.replace()` at all yields nothing",
  S("export const a = 1;\n").length === 0
);

ok(
  "CONTROL: an ordinary `.replace()` whose pattern is not a comment delimiter is not flagged",
  S('const x = s.replace(/\\s+/g, " ");\n').length === 0
);

/* ---- 2. THE TWO HAZARDS --------------------------------------------------- */

ok(
  "an UNANCHORED block stripper is a finding",
  (() => {
    const h = S("const x = s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');\n");
    return h.length === 1 && h[0].kind === "block" && h[0].anchored === false;
  })()
);

ok(
  "an UNANCHORED line stripper is a finding",
  (() => {
    const h = S("const x = s.replace(/\\/\\/[^\\n]*/g, '');\n");
    return h.length === 1 && h[0].kind === "line" && h[0].anchored === false;
  })()
);

ok(
  "a pattern naming BOTH delimiters is reported once, as block+line",
  (() => {
    const h = S("const x = s.replace(/\\/\\*|\\/\\//g, '');\n");
    return h.length === 1 && h[0].kind === "block+line";
  })()
);

/* ---- 3. ANCHORED IS REPORTED, NOT FAILED ---------------------------------- */

ok(
  "an ANCHORED line stripper is found but marked anchored, because the delimiter must begin the line",
  (() => {
    const h = S("const x = s.replace(/^[ \\t]*\\/\\/.*$/gm, '');\n");
    return h.length === 1 && h[0].anchored === true;
  })()
);

ok(
  "PAIRED CONTROL: the near-identical UNANCHORED form is NOT marked anchored, so the flag is not always true",
  (() => {
    const a = S("const x = s.replace(/^[ \\t]*\\/\\/.*$/gm, '');\n")[0];
    const b = S("const x = s.replace(/\\/\\/.*$/gm, '');\n")[0];
    return a.anchored === true && b.anchored === false;
  })()
);

ok(
  "the `[^:]` guard is NOT anchoring — it excludes `https://` and nothing else, so it stays a finding",
  S("const x = s.replace(/(^|[^:])\\/\\/.*$/gm, '$1');\n")[0].anchored === false
);

/* ---- 4. THE SUBJECT IS THE AST, NOT THE BYTES ----------------------------- */

/*
 * THE PROPERTY THAT MAKES THIS CHECKER POSSIBLE AT ALL. Its own source names the
 * constructs it hunts, eleven times, because it has to explain them. A grep-based
 * detector would report itself — the shape this repository keeps finding — so the
 * subject is a regex literal in ARGUMENT POSITION of a `.replace()` call, and
 * prose is not a call.
 */
ok(
  "a comment MENTIONING the delimiters is not a finding",
  S(
    "/* strip with slash-star ... star-slash and a line delimiter */\nexport const a = 1;\n"
  ).length === 0
);

ok(
  "a STRING containing the pattern is not a finding",
  S("const doc = \"s.replace(/\\\\/\\\\*[^]*?\\\\*\\\\//g, '')\";\n").length ===
    0
);

ok(
  "a regex literal NOT in `.replace()` argument position is not a finding",
  S("const RE = /\\/\\*[\\s\\S]*?\\*\\//g;\nexport const t = RE.test(x);\n")
    .length === 0
);

ok(
  "THE CHECKER DOES NOT FLAG ITSELF, driven against its own bytes rather than asserted",
  strippersIn(
    readFileSync(join(HERE, "assert-no-regex-comment-stripping.mjs"), "utf8"),
    "assert-no-regex-comment-stripping.mjs"
  ).length === 0
);

/* ---- 5. AN UNPARSED FILE IS A REFUSAL, NOT AN ABSENCE --------------------- */

ok(
  "a file that does not parse returns null, so the caller can refuse rather than read it as clean",
  S("function ( {{{ this is not javascript\n") === null
);

ok(
  "PAIRED CONTROL: a file that DOES parse returns an array, so null means something",
  Array.isArray(S("export const a = 1;\n"))
);

/* ---- #1215: A REFUSAL NO LONGER HIDES A FINDING -------------------------------- */

/*
 * The first arms here that drive main(). It lists `git ls-files scripts` in its cwd, so each
 * plant is STAGED in a throwaway repo. DEV1's fixture: an unanchored stripper beside a script
 * that does not parse. The unparsed-script refusal exited 2 before the finding was printed.
 */
const CHECKER = join(HERE, "assert-no-regex-comment-stripping.mjs");
const drive = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "strip-1215-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const [rel, body] of Object.entries(files))
    writeFileSync(join(dir, rel), body);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [CHECKER], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    code = e.status ?? -1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  rmSync(dir, { recursive: true, force: true });
  return { code, out };
};
const STRIPPER = "const x = s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');\n";
const UNPARSED = "const = ;\n";

const both = drive({
  "scripts/strip.mjs": STRIPPER,
  "scripts/broken.mjs": UNPARSED,
});
ok(
  "#1215: an unparsed script beside an unanchored stripper exits 1, and the finding is SHOWN",
  both.code === 1 &&
    /FAIL: 1 unanchored/.test(both.out) &&
    /scripts\/strip\.mjs/.test(both.out) &&
    !/PASS:/.test(both.out)
);
ok(
  "#1215: ...and the unparsed script is still named under COULD NOT CHECK",
  /COULD NOT CHECK 1 script[\s\S]*scripts\/broken\.mjs/.test(both.out)
);
const alone = drive({ "scripts/broken.mjs": UNPARSED });
ok(
  "#1215 CONTROL: the unparsed script alone exits 2, COULD NOT CHECK, and no PASS",
  alone.code === 2 &&
    /COULD NOT CHECK/.test(alone.out) &&
    !/PASS:/.test(alone.out)
);

const EXPECTED = 17;

/*
 * THE VERDICT COMES FROM AN EXIT HOOK AND NOTHING CALLS `process.exit` (#1122). Written the
 * ordinary way, an arm appended BELOW this block never runs and the suite reports the same green.
 * Changed by DEV3 while landing #1145's ratchet, which flagged this file the moment it could see
 * it -- the file is ARCHITECT's and the edit is mechanical, so say if you would rather own it.
 */
process.exitCode = 0;
process.on("exit", () => {
  const ran = pass + fail;
  console.log(`\n  ${pass}/${ran} passed`);
  if (fail !== 0) process.exitCode = 1;
  else if (ran !== EXPECTED) {
    console.error(
      `\nFAIL: ran ${ran}, expected ${EXPECTED} — a case was added or lost.`
    );
    process.exitCode = 1;
  }
});
