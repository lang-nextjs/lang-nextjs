#!/usr/bin/env node
/**
 * PROOF FOR check-discriminant-guards.mjs.
 *
 * THE CASE THAT MATTERS IS THE FOURTH DISCRIMINANT ARRIVING, and it cannot be
 * reached by editing the real tree — adding a field to the generated types to
 * see what happens would mean changing the manifest. So the audit is driven as a
 * pure function of a synthetic generated-types source, which is the only way to
 * watch #451's `reach` land before it lands.
 *
 * That case is the entire reason this checker is not a `shape` checker: a guard
 * that covers one discriminant makes the manifest LOOK guarded, so the next
 * field inherits the appearance without being examined. If the test below did
 * not exist, nothing would prove the family-level claim.
 */

import { audit } from "./check-discriminant-guards.mjs";

let failures = 0;
const ok = (label, cond, detail = "") => {
  if (!cond) failures++;
  console.log(
    `  ${cond ? "ok  " : "FAIL"}   ${label}${detail ? `   ${detail}` : ""}`,
  );
};

const GENERATED = `
export type RungShape = "conversation" | "run";
export type RungState = "implemented" | "planned";
export type RungTarget =
  | { readonly kind: "param" }
  | { readonly kind: "none" };
export interface Rung {
  readonly id: string;
  readonly ordinal: number;
  readonly shape: RungShape;
  readonly state: RungState;
  readonly target: RungTarget;
}
`;

const FILES = ["a.ts"];
const SRC = {
  "a.ts": [
    'if (r.shape === "conversation") return chat();',
    'const runs = rungs.filter((r) => r.shape !== "conversation");',
    'if (r.state === "planned") return null;',
  ].join("\n"),
};
const read = (f) => SRC[f] ?? "";
const run = (opts) =>
  audit({ generatedSrc: GENERATED, files: FILES, read, ...opts });

/* 1 — the ordinary case. */
{
  const r = run({
    coverage: { shape: { uncovered: "x" }, state: { uncovered: "y" } },
  });
  ok(
    "a fully-decided manifest passes",
    !r.fatal && r.failures.length === 0,
    (r.failures ?? []).join(" | ") || r.fatal || "",
  );
  ok(
    "  ...and both discriminants are derived, not restated",
    r.names.join(",") === "shape,state",
    r.names?.join(","),
  );
  ok(
    "  ...RungTarget is NOT counted — an object union is not a discriminant",
    !r.names.includes("target"),
  );
}

/* 2 — THE FOURTH FIELD. #451 adds `reach`; nobody remembers this file exists. */
{
  const withReach = GENERATED.replace(
    "  readonly target: RungTarget;",
    "  readonly reach: RungReach;\n  readonly target: RungTarget;",
  ).replace(
    "export interface Rung {",
    'export type RungReach = "local" | "remote";\nexport interface Rung {',
  );
  const r = audit({
    generatedSrc: withReach,
    files: FILES,
    read: (f) =>
      f === "a.ts" ? SRC["a.ts"] + '\nif (r.reach === "remote") {}' : "",
    coverage: { shape: { uncovered: "x" }, state: { uncovered: "y" } },
  });
  ok("a NEW discriminant with no decision FAILS", r.failures.length > 0);
  ok(
    "  ...and the failure names the field, not just the rule",
    r.failures.some((f) => /`reach`/.test(f)),
    r.failures[0],
  );
  ok(
    "  ...and says what to do about it",
    r.failures.some((f) => /witness|uncovered/.test(f)),
  );
}

/* 3 — a coverage claim that points at nothing is worse than an admitted gap. */
{
  const r = run({
    coverage: {
      shape: { witness: "scripts/this-witness-does-not-exist.test.mjs" },
      state: { uncovered: "y" },
    },
  });
  ok(
    "a witness path that does not exist FAILS",
    r.failures.some((f) => /does not exist/.test(f)),
    r.failures[0],
  );
}

/* 4 — the check losing its subject, two ways. Both must REFUSE, not pass. */
{
  const noIface = run({ coverage: {} });
  ok(
    "(control) an undecided real discriminant fails rather than passing",
    noIface.failures?.length > 0 || !!noIface.fatal,
  );

  const r1 = audit({
    generatedSrc: 'export type RungShape = "a" | "b";',
    files: FILES,
    read,
    coverage: {},
  });
  ok(
    "no Rung interface is FATAL, not a pass",
    /lost its subject/.test(r1.fatal ?? ""),
    r1.fatal,
  );

  const r2 = audit({
    generatedSrc: "export interface Rung {\n  readonly ordinal: number;\n}",
    files: FILES,
    read,
    coverage: {},
  });
  ok(
    "zero derived discriminants is FATAL",
    /0 discriminants/.test(r2.fatal ?? ""),
    r2.fatal,
  );
}

/* 5 — a scanner that finds nothing is broken, not reassuring. */
{
  const r = audit({
    generatedSrc: GENERATED,
    files: FILES,
    read: () => "// a file with no comparisons at all",
    coverage: { shape: { uncovered: "x" }, state: { uncovered: "y" } },
  });
  ok(
    "zero sites across every discriminant is FATAL, not a clean bill",
    /not evidence that nothing is there/.test(r.fatal ?? ""),
    r.fatal,
  );
}

/* 6 — and per-discriminant: an uncovered field nobody consumes is stale. */
{
  const r = audit({
    generatedSrc: GENERATED,
    files: FILES,
    read: () => 'if (r.shape === "conversation") {}',
    coverage: { shape: { uncovered: "x" }, state: { uncovered: "y" } },
  });
  ok(
    "an uncovered discriminant with no sites is reported as stale",
    r.failures.some((f) => /`state`.*0 comparison sites/s.test(f)),
    r.failures[0],
  );
}

console.log(
  failures === 0
    ? "\nPASS: the census derives its own subject, refuses to pass without one,\n" +
        "      and a discriminant that did not exist when it was written still\n" +
        "      has to be decided about."
    : `\nFAIL: ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
