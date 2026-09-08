#!/usr/bin/env node
/**
 * Proof for assert-nongating-comment-has-its-line.mjs (#995).
 *
 * THE FIRST ARM IS A POSITIVE CONTROL, and this checker needs one more than most: its healthy
 * output is a PASS about a line being present, and "the line is there" and "this checker cannot
 * tell whether the line is there" produce the same exit code. So the suite leads with a tree
 * where the line is absent and requires the checker to say so.
 *
 * THE ARM THAT MATTERS MOST IS `comment-only`. The step's own comment contains the string
 * `continue-on-error` in prose — it is the paragraph whose truth depends on the attribute — so a
 * grep-shaped checker would be satisfied by the very sentence in question and pass a workflow
 * where the attribute is gone. That arm plants exactly that tree.
 *
 * DRIVEN AT THE PROCESS LEVEL, not only over exported functions: a checker whose `main()` never
 * reaches its own comparison passes its unit arms and asserts nothing in CI. Each arm copies the
 * checker into a temp tree with a planted `.github/workflows/ci.yml` and runs it there, so the
 * path resolution and the exit vocabulary are exercised rather than assumed.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stepBlock,
  carriesContinueOnError,
} from "./assert-nongating-comment-has-its-line.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-nongating-comment-has-its-line.mjs");

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A workflow whose Audit step is spelled however the arm needs it. */
function workflow(stepName, attrLine) {
  return [
    "name: CI",
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Setup",
    "        run: echo setup",
    `      - name: ${stepName}`,
    "        # It cannot: continue-on-error means a failure here never fails the",
    "        # job, whatever pnpm does.",
    ...(attrLine ? [`        ${attrLine}`] : []),
    "        run: pnpm audit --audit-level=moderate",
    "      - name: Build",
    "        run: pnpm build",
    "",
  ].join("\n");
}

function runOn(yamlText) {
  const tree = mkdtempSync(join(tmpdir(), "nongating-"));
  mkdirSync(join(tree, "scripts", "lib"), { recursive: true });
  mkdirSync(join(tree, ".github", "workflows"), { recursive: true });
  copyFileSync(
    CHECKER,
    join(tree, "scripts", "assert-nongating-comment-has-its-line.mjs")
  );
  for (const m of ["is-main.mjs", "subject.mjs"])
    copyFileSync(join(HERE, "lib", m), join(tree, "scripts", "lib", m));
  writeFileSync(join(tree, ".github", "workflows", "ci.yml"), yamlText);
  const r = spawnSync(
    process.execPath,
    [join(tree, "scripts", "assert-nongating-comment-has-its-line.mjs")],
    { encoding: "utf8", timeout: 60000 }
  );
  rmSync(tree, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/* ── the positive control, first ── */
const absent = runOn(workflow("Audit dependencies", null));
ok(
  "POSITIVE CONTROL: the attribute absent is a FINDING, exit 1",
  absent.code === 1 && /carries no `continue-on-error` line/.test(absent.out),
  `exit=${absent.code}`
);

/* ── the arm a grep would fail ── */
ok(
  "comment-only: prose mentioning continue-on-error does NOT satisfy it",
  absent.code === 1 &&
    /continue-on-error means a failure here/.test(
      workflow("Audit dependencies", null)
    ),
  "the planted tree contains the phrase in a comment and still reds"
);

const healthy = runOn(
  workflow("Audit dependencies", "continue-on-error: true")
);
ok(
  "the attribute present as `true` passes, exit 0",
  healthy.code === 0 && /remains true/.test(healthy.out),
  `exit=${healthy.code}`
);

const spelledFalse = runOn(
  workflow("Audit dependencies", "continue-on-error: false")
);
ok(
  "`false` — the default spelled out — is a FINDING, not a pass",
  spelledFalse.code === 1 && /not `true`/.test(spelledFalse.out),
  `exit=${spelledFalse.code}`
);

const renamed = runOn(
  workflow("Audit dependencies (advisory)", "continue-on-error: true")
);
ok(
  "a RENAMED step REFUSES (exit 2) rather than reporting the comment false",
  renamed.code === 2 && /COULD NOT CHECK/.test(renamed.out),
  `exit=${renamed.code}`
);

const dup = runOn(
  workflow("Audit dependencies", "continue-on-error: true") +
    workflow("Audit dependencies", "continue-on-error: true")
);
ok(
  "an AMBIGUOUS name (two matching steps) REFUSES, exit 2",
  dup.code === 2 && /not exactly one/.test(dup.out),
  `exit=${dup.code}`
);

/* ── the indent discipline, driven over the exported reader ── */
const shellIf = [
  "      - name: Audit dependencies",
  "        run: |",
  "          continue-on-error: true",
  "      - name: Build",
]
  .join("\n")
  .split("\n");
{
  const { block, indent } = stepBlock(shellIf, "Audit dependencies");
  const got = carriesContinueOnError(block ?? [], indent ?? "      ");
  ok(
    "the same string inside a `run:` block does NOT count as a step attribute",
    got.present === false,
    `present=${got.present}`
  );
}

/* ── and the real workflow, so the shipped claim is asserted here too ── */
const real = spawnSync(process.execPath, [CHECKER], {
  encoding: "utf8",
  timeout: 60000,
});
ok(
  "the repository's own ci.yml satisfies it today",
  real.status === 0,
  `exit=${real.status}`
);

const total = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass}/${total}.`);
if (fail !== 0) process.exit(1);
