#!/usr/bin/env node
/**
 * PROOF THAT THE GUARD CAN FAIL, AND THAT THE CENSUS OVER IT CAN FAIL (#631).
 *
 * The defect being repaired is SILENCE — a script that exits 0 having printed nothing. A proof
 * for it cannot just assert the happy path: invoked directly, the broken form and the correct
 * one agree, which is exactly why thirty-six copies survived. Every behavioural case here runs
 * a real script through a REAL SYMLINK, because that is the only invocation that disagreed.
 *
 * The negative control is the load-bearing part. "The fixed script runs through a symlink"
 * would also pass for a guard that always answered true, so the same symlink is used to
 * reproduce the bug with the OLD form: nothing printed, exit 0.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { census } from "./assert-ismain-guards-resolve.mjs";

const SCRIPTS = dirname(realpathSync(fileURLToPath(import.meta.url)));
let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
};

/** Run `node <file>`, returning stdout+stderr and the exit code. */
function run(file, cwd) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [file], { cwd, encoding: "utf8" }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const TMP = mkdtempSync(join(tmpdir(), "is-main-"));
try {
  /* ── the behaviour, through a symlink ────────────────────────────────────────────────── */
  const real = join(TMP, "real");
  mkdirSync(join(real, "lib"), { recursive: true });
  writeFileSync(
    join(real, "lib", "is-main.mjs"),
    readFileSync(join(SCRIPTS, "lib", "is-main.mjs"), "utf8")
  );
  writeFileSync(
    join(real, "guarded.mjs"),
    `import { invokedAsProgram } from "./lib/is-main.mjs";\n` +
      `if (invokedAsProgram(import.meta.url)) console.log("MAIN RAN");\n`
  );
  writeFileSync(
    join(real, "old-form.mjs"),
    `import { fileURLToPath } from "node:url";\n` +
      `if (fileURLToPath(import.meta.url) === process.argv[1]) console.log("MAIN RAN");\n`
  );
  symlinkSync(real, join(TMP, "link"));

  const direct = run(join(real, "guarded.mjs"), TMP);
  check(
    "invoked directly, the guarded script runs main",
    direct.code === 0 && /MAIN RAN/.test(direct.out)
  );

  const linked = run(join(TMP, "link", "guarded.mjs"), TMP);
  check(
    "invoked THROUGH A SYMLINK, the guarded script still runs main",
    linked.code === 0 && /MAIN RAN/.test(linked.out),
    `code=${linked.code} out=${JSON.stringify(linked.out)}`
  );

  const oldLinked = run(join(TMP, "link", "old-form.mjs"), TMP);
  check(
    "THE BUG, REPRODUCED: the old form through the same symlink is silent and exits 0",
    oldLinked.code === 0 && oldLinked.out === "",
    `code=${oldLinked.code} out=${JSON.stringify(oldLinked.out)}`
  );

  /* ── imported, not invoked: must stay silent ─────────────────────────────────────────── */
  writeFileSync(
    join(real, "importer.mjs"),
    `import "./guarded.mjs";\nconsole.log("IMPORTER DONE");\n`
  );
  const imported = run(join(real, "importer.mjs"), TMP);
  check(
    "imported as a library, main does NOT run",
    imported.code === 0 &&
      /IMPORTER DONE/.test(imported.out) &&
      !/MAIN RAN/.test(imported.out)
  );
  check(
    "imported through a symlink, main still does NOT run",
    !/MAIN RAN/.test(run(join(TMP, "link", "importer.mjs"), TMP).out)
  );

  /* ── no argv[1] at all: a real answer, and a silent one ──────────────────────────────── */
  check(
    "with no argv[1] the answer is false, silently — node -e is not an invocation",
    (() => {
      const saved = process.argv[1];
      process.argv[1] = undefined;
      try {
        return invokedAsProgram(import.meta.url) === false;
      } finally {
        process.argv[1] = saved;
      }
    })()
  );

  /* ── cannot compute: REFUSES rather than assuming "library" ──────────────────────────── */
  /*
   * REACHING THIS BRANCH TOOK MEASURING, and two attempts at it were wrong — worth recording,
   * because an untestable branch is a claim rather than a behaviour.
   *
   * A DANGLING SYMLINK does not reach it: node fails to LOAD the module and dies before any
   * guard runs. A RELATIVE invocation does not either, nor does a module calling process.chdir()
   * at import time — node absolutises argv[1] before handing it over, so it stays resolvable
   * from anywhere. (It absolutises WITHOUT resolving symlinks, which is the whole bug.)
   *
   * What does reach it: the script's own file ceasing to exist while it runs. Not hypothetical
   * here — this repo's selftests copy scripts into temp trees and rmSync them, and eject deletes
   * files wholesale. The old code answered "I must be a library" and exited 0 in silence.
   */
  writeFileSync(
    join(real, "vanishes.mjs"),
    `import { unlinkSync } from "node:fs";\n` +
      `unlinkSync(process.argv[1]);\n` +
      `import { invokedAsProgram } from "./lib/is-main.mjs";\n` +
      `if (invokedAsProgram(import.meta.url)) console.log("MAIN RAN");\n`
  );
  const refused = run(join(real, "vanishes.mjs"), TMP);
  check(
    "an unresolvable invocation path REFUSES with exit 2, it does not fall silent",
    refused.code === 2 && /REFUSING TO GUESS/.test(refused.out),
    `code=${refused.code} out=${JSON.stringify(refused.out.slice(0, 160))}`
  );

  /* ── THE CENSUS ITSELF MUST BE ABLE TO FAIL ──────────────────────────────────────────── */
  /*
   * A census that has never been seen to reject is a claim. Both spellings are planted and the
   * real census() is pointed at them. The second matters most: it was invisible to the first
   * draft, because the string-stripper that makes the scan reliable ALSO erased form 2, which
   * contains a template literal. The probe came back clean from an instrument that had removed
   * its own subject.
   */
  const plant = join(TMP, "planted");
  mkdirSync(plant, { recursive: true });
  writeFileSync(
    join(plant, "clean.mjs"),
    `import { invokedAsProgram } from "./lib/is-main.mjs";\n` +
      `if (invokedAsProgram(import.meta.url)) run();\n`
  );
  check(
    "the census accepts a directory whose guards all resolve",
    census(plant).problems.length === 0
  );
  writeFileSync(
    join(plant, "old1.mjs"),
    `import { fileURLToPath } from "node:url";\n` +
      `if (fileURLToPath(import.meta.url) === process.argv[1]) run();\n`
  );
  /*
   * ASSERTED ON THE WHOLE NAME, not a tail. These matched /old1\.mjs/ while the checker was
   * naming files by slicing every path at its OWN directory's length — correct only when
   * scanning itself, and producing "scripts/-evidence.mjs" or a bare "scripts" anywhere else.
   * The count was right and the filename was fabricated by arithmetic; a tail match cannot
   * tell those apart, so it agreed with a message that would have sent a reader to no file.
   */
  check(
    "the census REFUSES the fileURLToPath form, and NAMES IT EXACTLY",
    census(plant).problems.some((p) => p.startsWith("old1.mjs decides isMain")),
    census(plant).problems.join(" | ")
  );
  writeFileSync(
    join(plant, "old2.mjs"),
    "if (import.meta.url === `file://${process.argv[1]}`) run();\n"
  );
  check(
    "the census REFUSES the `file://` form too, and NAMES IT EXACTLY",
    census(plant).problems.some((p) => p.startsWith("old2.mjs decides isMain")),
    census(plant).problems.join(" | ")
  );
  check(
    "a census that reads ZERO files REFUSES rather than reporting nothing wrong",
    (() => {
      const empty = join(TMP, "empty");
      mkdirSync(empty, { recursive: true });
      const r = census(empty);
      return (
        r.scanned === 0 && r.problems.some((p) => /scanned ZERO files/.test(p))
      );
    })()
  );

  /* ── THE SCANNER MUST NOT ERASE THE CODE IT IS SEARCHING (#656) ─────────────────────────
   *
   * Stripping strings is what lets a live guard be told from a quoted one. It also gave the
   * scanner the power to erase arbitrary code, and a REGEX LITERAL CONTAINING A QUOTE did:
   * `/"([^"]+)"/g` was read as opening a string, and everything after it in the file was
   * classified as quoted and never searched. A checker written after #634 shipped with the
   * broken guard form on the far side of exactly that construct and this census passed over it.
   *
   * EVERY CASE BELOW PLANTS THE GUARD *AFTER* THE CONSTRUCT, because the ones above plant near
   * the top of a fixture — which is how nine green cases and a live miss coexisted.
   */
  const GUARD =
    "if (fileURLToPath(import.meta.url) === process.argv[1]) main();\n";
  const after = (prelude) => {
    const d = join(TMP, `after-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "x.mjs"), prelude + "\n" + GUARD);
    return census(d);
  };

  for (const [label, prelude] of [
    ['a regex containing "', 'const rx = /"([^"]+)"/g;'],
    ["a regex containing '", "const rx = /'([^']+)'/g;"],
    ["a regex containing a backtick", "const rx = /`([^`]+)`/g;"],
    [
      "the live victim's shape (matchAll with a quoted pattern)",
      'function q(m) {\n  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);\n}',
    ],
    [
      "a nested template in an interpolation",
      'const t = `outer ${items.map((i) => `${i.name}`).join(", ")} end`;',
    ],
  ])
    check(
      `a broken guard AFTER ${label} is still found`,
      after(prelude).problems.some((p) => /decides isMain with/.test(p)),
      JSON.stringify(after(prelude).problems)
    );

  /*
   * THE OTHER DIRECTION, and it is the one a regex-aware scanner gets wrong: division must not be
   * read as a regex. If it were, the scanner would swallow from the `/` to the next `/` and erase
   * real code — the same failure with a different cause.
   */
  {
    const d = join(TMP, "division");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "x.mjs"),
      "const ratio = (a, b) => a / b / 2;\nconst pct = total / count;\n" +
        'import { invokedAsProgram } from "./lib/is-main.mjs";\n' +
        "if (invokedAsProgram(import.meta.url)) main();\n"
    );
    check(
      "division is not mistaken for a regex (no false report, nothing erased)",
      census(d).problems.length === 0,
      JSON.stringify(census(d).problems)
    );
  }

  /*
   * AND WHEN THE SCANNER CANNOT FINISH, IT SAYS SO. Whatever the construct, a read that ends
   * inside a literal has not searched the tail — reporting "clean" about that file would be the
   * silence this whole check exists to remove, one level up.
   */
  {
    const d = join(TMP, "unterminated");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "x.mjs"), "const s = `never closed\nmain();\n");
    check(
      "a file whose scan ends inside a literal is REFUSED, not reported clean",
      census(d).problems.some((p) => /could not be scanned/.test(p)),
      JSON.stringify(census(d).problems)
    );
  }

  /* ── and the real tree is clean, measured with the SAME function the checker runs ────── */
  /*
   * Not a second copy of the scan. An earlier draft re-implemented it here as a plain
   * `src.includes` and that copy reported the helper and this file as offenders — both quote
   * the broken forms, one to explain what it replaces and one to reproduce the bug. Two
   * implementations of one question is how they come to disagree.
   */
  const live = census(SCRIPTS);
  check(
    "the census actually read the scripts directory",
    live.scanned > 20,
    `only ${live.scanned} files under ${SCRIPTS}`
  );
  check(
    "no script in scripts/ still compares a resolved path to an unresolved one",
    live.problems.length === 0,
    live.problems.join(" | ")
  );
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

const total = pass + fail;
if (fail !== 0) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The guard answers the same through a symlink as directly —\n` +
    `      proven against the old form, which under that same symlink prints nothing and\n` +
    `      exits 0 — stays silent when imported, and REFUSES with exit 2 when it cannot\n` +
    `      resolve the invocation path rather than assuming it is a library. The census\n` +
    `      rejects both broken spellings and refuses a scan that read nothing.\n` +
    `      It finds a broken guard sitting AFTER a regex literal containing a quote — the\n` +
    `      construct that desynchronised the scanner and let a live 37th script through —\n` +
    `      does not mistake division for a regex, and refuses any file whose read ended\n` +
    `      inside a literal rather than calling the part it never saw clean.`
);
