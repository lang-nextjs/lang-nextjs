#!/usr/bin/env node
/**
 * assert-format-writes.selftest.mjs — proves the checker can FAIL, and fails for the
 * right reason.
 *
 * THE MUTANT IS THE HISTORICAL DEFECT, NOT AN INVENTED ONE. It restores the exact line
 * #816 fixed —
 *
 *     const passed = args.length ? args : ["--write", "."];
 *
 * — so the red arm below is the bug that actually shipped and that a person actually
 * committed on top of, rather than a synthetic edit chosen because it is easy to detect.
 *
 * THE MUTANT LIVES IN A TEMP DIRECTORY. A copy under scripts/ would enter the subject of
 * assert-formatted and assert-checkers-registered, so proving THIS checker would fail
 * two others — and the formatting one fires at exit 1 before the assertion under test is
 * reached, which reads as this proof failing. That is the trap DEV2 hit on #823, and it
 * is why the checker takes `--format`.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  symlinkSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-format-writes.mjs");
const FORMAT = join(ROOT, "scripts", "format.mjs");

let pass = 0;
let fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} — got ${JSON.stringify(got)}`);
  }
};

const run = (args) => {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

// GREEN ARM — the real format.mjs.
{
  const r = run([]);
  ok("the real `pnpm format` passes every form", r.code === 0, r);
  ok(
    "...and it reports a subject, so a pass over nothing is distinguishable",
    /SUBJECT: 3 invocation form\(s\)/.test(r.out),
    r.out.split("\n").find((l) => l.startsWith("SUBJECT")) ?? r.out
  );
}

// RED ARM — the historical defect, restored in a temp copy.
{
  const dir = mkdtempSync(join(tmpdir(), "format-mutant-"));
  try {
    /*
     * THE MUTANT NEEDS THE REAL node_modules, and finding that out is why the
     * companion assertion below exists. format.mjs resolves its prettier as
     * `join(ROOT, "node_modules", ".bin", "prettier")` with ROOT derived from its own
     * location, so a bare copy in /tmp REFUSES with "prettier is not installed" — and
     * the checker then reports both write-forms as not writing. The red arm went red,
     * for a reason that had nothing to do with the mutation. A `scripts/` sibling is
     * placed one level down so the same `../node_modules` resolution lands here.
     */
    mkdirSync(join(dir, "scripts"));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    copyFileSync(join(ROOT, "package.json"), join(dir, "package.json"));
    const mutant = join(dir, "scripts", "format.mjs");
    copyFileSync(FORMAT, mutant);
    const src = readFileSync(mutant, "utf8");
    const patched = src.replace(
      /const passed = prettierArgs\(args, subjectPaths\);/,
      'const passed = args.length ? args : ["--write", "."];'
    );
    /*
     * A MUTATION THAT DID NOT APPLY IS A GREEN THAT PROVES NOTHING, and it would read
     * here as "the checker cannot fail" — the opposite of what this arm exists to show.
     * So the substitution is asserted before the mutant is ever run.
     */
    ok(
      "the mutation APPLIED — otherwise the red arm below tests the fixed code",
      patched !== src,
      "replace() matched nothing; the anchor in format.mjs has moved"
    );
    writeFileSync(mutant, patched);

    const r = run(["--format", mutant]);
    ok("RED: the pre-#816 format.mjs FAILS the check (exit 1)", r.code === 1, {
      code: r.code,
      out: r.out.slice(0, 200),
    });
    ok(
      "...and it names the PATH form specifically, not all three",
      /a path argument: the file is BYTE-IDENTICAL/.test(r.out) &&
        !/--write and a path: the file is BYTE-IDENTICAL/.test(r.out),
      r.out.slice(0, 300)
    );
    ok(
      "...and the failure says WHY it happened, not only that it did",
      /without --write/.test(r.out) && /wrote nothing/.test(r.out),
      r.out.slice(0, 300)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * THE REFUSAL ARM. If the planted file were already formatted, every writes:true case
 * would report "unchanged" and the checker would fail blaming format.mjs for something
 * it did not do. Driven by a format.mjs stand-in that does nothing at all: --check then
 * exits 0, the control fires, and the checker must REFUSE (2) rather than FAIL (1).
 */
{
  const dir = mkdtempSync(join(tmpdir(), "format-inert-"));
  try {
    const inert = join(dir, "format.mjs");
    writeFileSync(inert, "process.exit(0);\n");
    const r = run(["--format", inert]);
    ok(
      "an inert format.mjs makes the control fire: REFUSE (2), not FAIL (1)",
      r.code === 2,
      { code: r.code, out: r.out.slice(0, 200) }
    );
    ok(
      "...and the refusal blames the PROBE, not format.mjs",
      /already considered formatted/.test(r.out),
      r.out.slice(0, 250)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * THE SEAM ARM. The subject-source check is a SOURCE-LEVEL proxy, so it needs proving in
 * both directions or it is a green that cannot fail. The mutant here removes the dynamic
 * import of `analyse` and replaces it with an inlined list — the exact regression #816
 * would be, and the one the checker cannot catch by driving.
 *
 * IT ALSO GUARDS THE PATTERN. The first version of this check looked for `from "./..."`
 * and format.mjs uses `await import("./...")`, so it reported the seam broken against
 * the CORRECT file. A red arm alone would have passed against that bug; the green arm
 * above, run on the real source, is what fails when the pattern cannot match its subject.
 */
{
  const dir = mkdtempSync(join(tmpdir(), "format-seam-"));
  try {
    mkdirSync(join(dir, "scripts"));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    copyFileSync(join(ROOT, "package.json"), join(dir, "package.json"));
    const mutant = join(dir, "scripts", "format.mjs");
    const src = readFileSync(FORMAT, "utf8");
    const patched = src.replace(
      'const { analyse } = await import("./assert-formatted.mjs");',
      'const analyse = async () => ({ subject: ["."] });'
    );
    ok(
      "the seam mutation APPLIED",
      patched !== src,
      "the dynamic import line in format.mjs has moved"
    );
    writeFileSync(mutant, patched);

    const r = run(["--format", mutant]);
    ok(
      "RED: a format.mjs that INLINES its subject fails the seam check",
      r.code === 1 && /no longer imports `analyse`/.test(r.out),
      { code: r.code, out: r.out.slice(0, 220) }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXPECTED = 10;
const total = pass + fail;
if (total !== EXPECTED) {
  console.log(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail === 0 ? 0 : 1);
