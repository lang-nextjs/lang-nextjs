#!/usr/bin/env node
/**
 * PROOF FOR assert-overrides-entail-declarations (#1131).
 *
 * The range parser is the part that can be confidently wrong, so it is driven against KNOWN
 * ANSWERS rather than against itself -- including npm's caret-on-zero rules, which are where a
 * hand-rolled semver actually breaks, and the nine forms it must REFUSE rather than guess.
 * `semver` is not resolvable from this repo's root; that is why the subset is small and why
 * refusing is a first-class outcome instead of an edge case.
 */
import {
  parseVersion,
  cmp,
  parseRange,
  permitsBelowFloor,
  declarationsOf,
  overridesOf,
  evaluate,
  FIELDS,
  main,
  Refusal,
} from "./assert-overrides-entail-declarations.mjs";

const results = [];
const EXPECTED = 29;
process.exitCode = 0;
process.on("exit", () => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results)
    process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
  process.stdout.write(
    `\n  ${results.length - failed.length}/${results.length} passed\n`
  );
  if (results.length !== EXPECTED)
    process.stderr.write(
      `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
    );
  if (failed.length > 0 || results.length !== EXPECTED) process.exitCode = 1;
});
const ok = (name, cond) => results.push({ ok: !!cond, name });
const R = (s) => {
  const r = parseRange(s);
  return r === null
    ? "REFUSED"
    : `${r.lo.join(".")}..${r.hi ? r.hi.join(".") : "inf"}`;
};

/* ---- the version primitive ---------------------------------------------------------------- */
ok("a three-integer version parses", String(parseVersion("1.2.3")) === "1,2,3");
ok("a non-numeric version does not", parseVersion("1.2.x") === null);
ok("an empty version does not", parseVersion("") === null);
ok(
  "cmp orders by major, then minor, then patch",
  cmp([1, 2, 3], [1, 3, 0]) === -1 &&
    cmp([2, 0, 0], [1, 9, 9]) === 1 &&
    cmp([1, 2, 3], [1, 2, 3]) === 0
);

/* ---- the decidable subset, against KNOWN npm semantics ------------------------------------ */
ok("^1.2.3 holds the MAJOR — [1.2.3, 2.0.0)", R("^1.2.3") === "1.2.3..2.0.0");
ok(
  "^0.2.3 holds the MINOR, because the leftmost non-zero component is what caret pins",
  R("^0.2.3") === "0.2.3..0.3.0"
);
ok(
  "^0.0.3 holds the PATCH, the same rule taken one further",
  R("^0.0.3") === "0.0.3..0.0.4"
);
ok("~1.2.3 holds the minor — [1.2.3, 1.3.0)", R("~1.2.3") === "1.2.3..1.3.0");
ok(">=6.4.2 is unbounded above", R(">=6.4.2") === "6.4.2..inf");
ok("a bare version is the exact version alone", R("8.2.2") === "8.2.2..8.2.3");

/* ---- REFUSING IS A VERDICT ABOUT THE CHECK, NOT ABOUT THE RANGE --------------------------- */
ok("a union refuses", R("^1.2.3 || ^2.0.0") === "REFUSED");
ok("an upper-bound-only range refuses", R("<3.0.0") === "REFUSED");
ok("a prerelease refuses", R("1.2.3-beta.1") === "REFUSED");
ok("a dist-tag refuses", R("latest") === "REFUSED");
ok("a workspace protocol refuses", R("workspace:*") === "REFUSED");
ok("a catalog protocol refuses", R("catalog:") === "REFUSED");
ok(
  "a wildcard refuses, and is NOT read as `no constraint`",
  R("*") === "REFUSED"
);
ok("an x-range refuses", R("1.x") === "REFUSED");
ok(
  "an EMPTY string refuses rather than being treated as absent",
  R("") === "REFUSED"
);

/* ---- the property, including the instance that motivated the check ------------------------ */
ok(
  "#1131's motivating case: an exact pin below a declared caret permits a version below the floor",
  permitsBelowFloor(parseRange("19.2.6"), parseRange("^19.2.7")) === true
);
ok(
  "a FLOOR lower than the declared floor does it too — the narrowing this check was nearly built around",
  permitsBelowFloor(parseRange(">=6.4.2"), parseRange("^8.2.2")) === true &&
    permitsBelowFloor(parseRange(">=8.5.23"), parseRange("^8.5.28")) === true
);
ok(
  "an exact pin INSIDE the declared range is fine, and an override at or above the floor is fine",
  permitsBelowFloor(parseRange("8.5.28"), parseRange("^8.5.28")) === false &&
    permitsBelowFloor(parseRange(">=8.2.2"), parseRange("^8.2.2")) === false
);
ok(
  "THE DECLARED NON-SUBJECT: an override ABOVE every declared range is NOT reported — it is a real hazard in the other direction and is out of scope by a written rule",
  permitsBelowFloor(parseRange("^9.0.0"), parseRange("^8.2.2")) === false
);

/* ---- absent versus empty, which are different states -------------------------------------- */
ok(
  "an ABSENT pnpm.overrides and an EMPTY one are distinguished rather than collapsed",
  overridesOf({}).present === false &&
    overridesOf({ pnpm: {} }).present === false &&
    overridesOf({ pnpm: { overrides: {} } }).present === true &&
    Object.keys(overridesOf({ pnpm: { overrides: {} } }).entries).length === 0
);

/* ---- the subject is overrides a manifest DECLARES ------------------------------------------ */
ok(
  "a transitive-only override is not in subject, and a declared one is — with the refused count reported either way",
  (() => {
    const manifests = [
      { path: "a/package.json", json: { dependencies: { vite: "^8.2.2" } } },
      {
        path: "b/package.json",
        json: { devDependencies: { other: "^1.0.0" } },
      },
    ];
    const r = evaluate({ vite: ">=6.4.2", tar: ">=7.5.21" }, manifests);
    return (
      r.declaredOverrides.length === 1 &&
      r.declaredOverrides[0] === "vite" &&
      r.violations.length === 1 &&
      r.refused.length === 0 &&
      r.decided === 1
    );
  })()
);

/*
 * A REFUSAL IS COUNTED AND NAMED, AND IT DOES NOT BECOME A PASS.
 *
 * The arm above asserts `refused === 0`, which is the ordinary case and cannot tell a checker that
 * counts refusals from one that silently drops the undecidable. This one drives a range the subset
 * does not cover and requires that the override leaves the DECIDED tally without entering the
 * violation list -- a skipped member must be visible as a number, not absent from both.
 */
ok(
  "an undecidable range is REFUSED and counted, entering neither the violations nor the decided tally",
  (() => {
    const manifests = [
      {
        path: "a/package.json",
        json: { dependencies: { vite: "^8.2.2 || ^9.0.0" } },
      },
    ];
    const r = evaluate({ vite: ">=6.4.2" }, manifests);
    return (
      r.declaredOverrides.length === 1 &&
      r.violations.length === 0 &&
      r.refused.length === 1 &&
      r.decided === 0 &&
      /not a form this check decides/.test(r.refused[0])
    );
  })()
);

ok(
  "an undecidable OVERRIDE range refuses before any declaration is consulted",
  (() => {
    const manifests = [
      { path: "a/package.json", json: { dependencies: { vite: "^8.2.2" } } },
    ];
    const r = evaluate({ vite: "workspace:*" }, manifests);
    return (
      r.violations.length === 0 && r.refused.length === 1 && r.decided === 0
    );
  })()
);

/* ---- the refusals in main(), which are about the TREE rather than a range ------------------ */
ok(
  "an empty manifest list REFUSES rather than reporting an empty subject",
  (() => {
    try {
      main([], {
        here: "/nowhere",
        root: "/nowhere",
        read: () => "{}",
        list: () => [],
      });
      return false;
    } catch (e) {
      return e instanceof Refusal && /never read/.test(e.message);
    }
  })()
);

/*
 * `overrides: null` IS A THIRD STATE, AND A FALSY TEST COLLAPSES IT INTO "ABSENT".
 *
 * Found by mutation: replacing `!("overrides" in pnpm)` with `!pnpm.overrides` survived every arm,
 * because `{}` is truthy and absent is undefined -- the two states the arm above tests behave
 * identically under both. `null` is where they diverge, and it is the state a hand-edit or a
 * generator most plausibly leaves behind. Present-and-null means the repo SAYS it has overrides and
 * supplies none, which is a different fact from never having said so.
 */
ok(
  "`overrides: null` is PRESENT with no entries, not absent — the state a falsy test collapses",
  overridesOf({ pnpm: { overrides: null } }).present === true &&
    Object.keys(overridesOf({ pnpm: { overrides: null } }).entries).length === 0
);
