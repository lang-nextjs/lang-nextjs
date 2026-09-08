/**
 * PROOF FOR assert-no-nul-in-text-sources.mjs — it FINDS a planted NUL, finds one past the
 * window `git` stops looking at, and stays silent on files that are binary by nature (#1060).
 *
 * WHY THE POSITIVE CONTROL IS THE FIRST ARM AND NOT AN AFTERTHOUGHT. This checker's entire
 * output on a healthy tree is "0 violations", and that is the SAME output a checker would
 * produce if it could not see NULs at all — wrong extension logic, a read that returns a string
 * instead of bytes, a scan that stops early. The defect this guard exists to catch is a silent
 * false negative, so a guard whose own healthy state is silence has to prove it can speak.
 *
 * AND THE SECOND ARM IS THE ONE THAT DISTINGUISHES THIS FROM `git`. git inspects only the first
 * 8000 bytes for a NUL, so a byte at offset 10112 — exactly where #1055's was — leaves git
 * calling the file text. Anyone "optimising" this scan to a prefix read would reintroduce the
 * miss, and only that arm would notice.
 */
import {
  scan,
  firstNulOffset,
  lineOfOffset,
  isAllowedBinary,
  ALLOWED_BINARY_EXTENSIONS,
} from "./assert-no-nul-in-text-sources.mjs";

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};

const EXPECTED = 10;

/** A file list plus a reader, so nothing here writes into the repository it asserts about. */
const over = (contents) =>
  scan(Object.keys(contents), (p) => contents[p] ?? null);

console.log("\nassert-no-nul-in-text-sources — bytes, not git's first 8000\n");

/* ── 1. THE POSITIVE CONTROL ───────────────────────────────────────────────── */
{
  const planted = Buffer.concat([
    Buffer.from("const key = `a"),
    Buffer.from([0x00]),
    Buffer.from("b`;\n"),
  ]);
  const r = over({ "scripts/thing.mjs": planted });
  ok(
    "POSITIVE CONTROL: a planted NUL in a text file is FOUND",
    r.violations.length === 1 && r.violations[0].path === "scripts/thing.mjs",
    `violations=${r.violations.length}`
  );
  ok(
    "and it reports the byte offset, so the complaint points somewhere",
    r.violations[0]?.offset === 14,
    `offset=${r.violations[0]?.offset}`
  );
}

/* ── 2. THE DISCRIMINATOR AGAINST git's 8000-BYTE WINDOW ───────────────────── */
{
  const far = Buffer.concat([
    Buffer.alloc(10112, 0x41),
    Buffer.from([0x00]),
    Buffer.from("tail\n"),
  ]);
  const r = over({ "scripts/far.mjs": far });
  ok(
    "a NUL at offset 10112 is found — past the 8000 bytes `git` inspects",
    r.violations.length === 1 && r.violations[0].offset === 10112,
    `offset=${r.violations[0]?.offset}`
  );
  /*
   * The prefix-read regression, stated as its own arm because it is the one an optimisation
   * would introduce and every other arm here would still pass.
   */
  ok(
    "firstNulOffset reads the WHOLE buffer, not a prefix",
    firstNulOffset(far) === 10112 &&
      firstNulOffset(far.subarray(0, 8000)) === -1,
    `whole=${firstNulOffset(far)} prefix=${firstNulOffset(
      far.subarray(0, 8000)
    )}`
  );
}

/* ── 3. THE ALLOWLIST ──────────────────────────────────────────────────────── */
{
  const binary = Buffer.from([0x89, 0x50, 0x00, 0x0d]);
  const r = over({
    "e2e/shot.png": binary,
    "scripts/fixtures/x.bundle": binary,
    "apps/x/__pycache__/y.pyc": binary,
  });
  ok(
    "files that are binary by nature are not violations",
    r.violations.length === 0,
    `violations=${r.violations.length}`
  );
  ok(
    "the allowance is case-insensitive, so `.PNG` is the same allowance",
    isAllowedBinary("e2e/SHOT.PNG") === true,
    `isAllowedBinary('.PNG')=${isAllowedBinary("e2e/SHOT.PNG")}`
  );
  /*
   * AND THE SILENT ARM ABOVE SAW ITS INPUT. Three allowed files with no violations is also
   * what a scan that read nothing would report.
   */
  ok(
    "...and that silence is over three files actually read",
    r.examined === 3,
    `examined=${r.examined}`
  );
}

/* ── 4. AN ALLOWANCE THAT EXCEPTS NOTHING IS A FINDING ─────────────────────── */
{
  const r = over({ "docs/clean.md": Buffer.from("no nul here\n") });
  ok(
    "an allowance no tracked file needs is reported, not silently kept",
    r.unusedAllowances.length === ALLOWED_BINARY_EXTENSIONS.size,
    `unused=${r.unusedAllowances.length} of ${ALLOWED_BINARY_EXTENSIONS.size}`
  );
  ok(
    "a clean text file is not a violation",
    r.violations.length === 0 && r.examined === 1,
    `violations=${r.violations.length} examined=${r.examined}`
  );
}

/* ── 5. THE LINE NUMBER IS REAL ────────────────────────────────────────────── */
{
  const b = Buffer.concat([Buffer.from("a\nb\nc"), Buffer.from([0x00])]);
  ok(
    "the reported line counts newlines before the byte",
    lineOfOffset(b, 5) === 3,
    `line=${lineOfOffset(b, 5)}`
  );
}

const total = results.length;
let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.ok ? "" : `  [${r.detail}]`}`
  );
}
if (printed !== total) {
  console.error(
    `\nFAIL: ${total} case(s) ran and ${printed} printed — some are invisible.`
  );
  process.exit(1);
}
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} case(s), expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (pass !== total) {
  console.error(`\nFAIL: ${pass}/${total}.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The first arm proves the scanner can SPEAK, and the second proves\n` +
    `      it looks past the 8000 bytes git stops at — without those two, "0 violations" and\n` +
    `      "cannot see NULs at all" would be the same output.`
);
