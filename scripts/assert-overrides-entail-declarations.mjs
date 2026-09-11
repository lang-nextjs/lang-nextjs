#!/usr/bin/env node
/**
 * AN OVERRIDE MUST ENTAIL EVERY RANGE THAT DECLARES THE PACKAGE (#1131).
 *
 * `pnpm.overrides` replaces the resolved version of a dependency wherever it appears, INCLUDING in
 * workspaces whose own manifest declares a range. If the override permits a version the declaring
 * manifest rejects, the manifest's constraint has been silently discarded -- pnpm will not warn,
 * because the override is the thing it was told to obey.
 *
 * THE MOTIVATING INSTANCE, WHICH IS NOW CLOSED. `pnpm.overrides` held `react-dom` at exact `19.2.6`
 * while every manifest declared `^19.2.7`. React's runtime enforces exact equality between `react`
 * and `react-dom`, the peer range is a caret and therefore permits the mismatch, and the failure
 * surfaced only as `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` when Dependabot rewrote the lockfile's
 * overrides block and not the manifest's. The entry is gone; nothing asserts that the next one
 * cannot arrive.
 *
 * IT IS NOT SPECIFIC TO EXACT PINS, WHICH IS THE NARROWING THIS CHECK WAS NEARLY BUILT AROUND.
 * A FLOOR LOWER THAN A DECLARED FLOOR HAS THE SAME EFFECT: an override does not have to FORCE a
 * below-range resolution, it only has to STOP PREVENTING one, and the constraint that would have
 * prevented it is the one the override replaced. Measured on this repo the day this was written:
 *
 *     vite     >=6.4.2    declared ^8.2.2    permits every 6.x and 7.x, which ^8.2.2 rejects
 *     postcss  >=8.5.23   declared ^8.5.28   the same shape, four patch versions of slack
 *
 * BOTH RESOLVED CORRECTLY ANYWAY -- 8.2.2 and 8.5.28 -- because pnpm picks the highest satisfying
 * version and the registry offered one. That is the reason this is an assertion and not a cleanup:
 * the tree is correct BY RESOLUTION, not BY CONSTRAINT, and there is nothing to clean.
 *
 * REFUSES RATHER THAN GUESSES ON A RANGE FORM IT CANNOT DECIDE. `semver` is not resolvable from
 * this repo's root, so entailment is decided over a deliberately small subset -- exact, `>=`, `^`,
 * `~` -- and any other form (unions, `<`, tags, `workspace:`, `catalog:`, prereleases, urls) is
 * REPORTED AS REFUSED AND COUNTED. A checker that answers wrongly about an exotic range is a false
 * green on its own subject; one that says which forms it could not decide leaves a number someone
 * can close. The refused count is in the subject line, not a footnote.
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { reportSubject } from "./lib/subject.mjs";
import { refuseUnanticipated } from "./lib/refusal.mjs";

export class Refusal extends Error {}

/** The dependency fields an override can displace. `peerDependencies` included deliberately. */
export const FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

const NUM = /^(\d+)\.(\d+)\.(\d+)$/;

/** A version as a comparable triple, or null when it is not three plain integers. */
export function parseVersion(v) {
  const m = NUM.exec(String(v ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * A range as a half-open interval [lo, hi), with `hi === null` meaning unbounded.
 *
 * Returns `null` for any form outside the decidable subset — that is a REFUSAL to answer, not a
 * verdict, and every caller must treat it as such rather than as "no constraint".
 */
export function parseRange(spec) {
  const s = String(spec ?? "").trim();
  if (s === "") return null;
  /*
   * NO BROAD "LOOKS EXOTIC" GUARD HERE, AND IT WAS REMOVED RATHER THAN LEFT IN.
   *
   * An earlier draft rejected anything containing whitespace, `||`, `<`, `*`, `x` or `:` before
   * reaching the specific parsers. Probed against 25 range forms it changed the answer on ZERO of
   * them -- the four parsers below already refuse every one, because each requires its own exact
   * shape and returns null otherwise. A redundant guard is not free: it makes the parsers beneath
   * it look like a formality, so the next person tightening or loosening one has a reason to think
   * the hard cases were already handled above. The refusal path is the parsers, and only them.
   */
  if (s.includes("-")) return null; // prereleases and hyphen ranges: not decided here

  const exact = parseVersion(s);
  if (exact) return { lo: exact, hi: [exact[0], exact[1], exact[2] + 1] };

  if (s.startsWith(">=")) {
    const lo = parseVersion(s.slice(2));
    return lo ? { lo, hi: null } : null;
  }
  if (s.startsWith("^")) {
    const lo = parseVersion(s.slice(1));
    if (!lo) return null;
    const [maj, min] = lo;
    // npm's caret: the leftmost NON-ZERO component is what is held.
    if (maj > 0) return { lo, hi: [maj + 1, 0, 0] };
    if (min > 0) return { lo, hi: [0, min + 1, 0] };
    return { lo, hi: [0, 0, lo[2] + 1] };
  }
  if (s.startsWith("~")) {
    const lo = parseVersion(s.slice(1));
    return lo ? { lo, hi: [lo[0], lo[1] + 1, 0] } : null;
  }
  return null;
}

/**
 * THE PROPERTY IS THE LOWER BOUND, AND THE UPPER BOUND IS A DECLARED NON-SUBJECT.
 *
 * The override permits a version BELOW what a declaring manifest requires. That is #1131's own
 * title -- an override may "hold a package at a version no declaring manifest can accept", and
 * "hold at" is about being held DOWN -- and it catches the motivating instance exactly: `19.2.6`
 * under a declared `^19.2.7`.
 *
 * WHY NOT FULL INTERVAL ENTAILMENT, WHICH IS THE OBVIOUS PROPERTY AND THE WRONG ONE HERE. Every
 * override in this repo is a FLOOR whose job is to lift TRANSITIVE consumers past an advisory.
 * Full entailment additionally requires the override's upper bound inside the declared one, which
 * for `>=8.2.2` against `^8.2.2` is unsatisfiable without rewriting the floor as a caret -- capping
 * it at major 8 and destroying what the override is for. A check whose only satisfying
 * configuration defeats the thing it checks is a check nobody keeps.
 *
 * SO THE UPPER-BOUND HAZARD IS REAL AND IS NOT THIS CHECKER'S SUBJECT. An override ABOVE every
 * declared range -- `^9.0.0` against `^8.2.2` -- forces a version the manifest also rejects, in the
 * other direction. It is written down rather than left to be discovered, because a domain that
 * shrinks by an UNWRITTEN rule is a defect and one that shrinks by a WRITTEN rule is a scope.
 * Extending to it means deciding what a floor may do to a declaring workspace, which is a
 * dependency-policy question rather than a parsing one.
 */
export function permitsBelowFloor(ovr, dec) {
  return cmp(ovr.lo, dec.lo) < 0;
}

/** Every (manifest, field) that declares `pkg`, across the manifests given. */
export function declarationsOf(pkg, manifests) {
  const out = [];
  for (const { path, json } of manifests)
    for (const field of FIELDS) {
      const spec = json?.[field]?.[pkg];
      if (typeof spec === "string" && spec !== "")
        out.push({ path, field, spec });
    }
  return out;
}

/**
 * THE OVERRIDES BLOCK, DISTINGUISHING ABSENT FROM EMPTY.
 *
 * `pnpm.overrides` absent and `pnpm.overrides: {}` are different states and a `??` or `||` would
 * collapse them. An absent block means the repo declares no overrides; an empty one means it
 * declares that it has none, which is a thing a previous change can leave behind. Both yield an
 * empty subject here, and the DISTINCTION is reported rather than flattened.
 */
export function overridesOf(rootJson) {
  const pnpm = rootJson?.pnpm;
  if (pnpm === undefined || pnpm === null)
    return { present: false, entries: {} };
  if (!("overrides" in pnpm)) return { present: false, entries: {} };
  const o = pnpm.overrides;
  if (o === null || typeof o !== "object")
    return { present: true, entries: {} };
  return { present: true, entries: o };
}

export function evaluate(overrides, manifests) {
  const violations = [];
  const refused = [];
  let decided = 0;
  const declaredOverrides = [];

  for (const [pkg, spec] of Object.entries(overrides)) {
    const decls = declarationsOf(pkg, manifests);
    if (decls.length === 0) continue; // transitive only: no declared range to violate
    declaredOverrides.push(pkg);

    const ovr = parseRange(spec);
    if (!ovr) {
      refused.push(
        `${pkg}: override range \`${spec}\` is not a form this check decides`
      );
      continue;
    }
    let anyRefused = false;
    for (const d of decls) {
      const dec = parseRange(d.spec);
      if (!dec) {
        refused.push(
          `${pkg}: declared range \`${d.spec}\` in ${d.path} (${d.field}) is not a form this check decides`
        );
        anyRefused = true;
        continue;
      }
      if (permitsBelowFloor(ovr, dec))
        violations.push(
          `${pkg}: override \`${spec}\` permits versions BELOW what ${d.path} (${d.field}) requires — it declares \`${d.spec}\``
        );
    }
    if (!anyRefused) decided += 1;
  }
  return { violations, refused, decided, declaredOverrides };
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

export function main(argv = [], io = {}) {
  const here = io.here ?? dirname(fileURLToPath(import.meta.url));
  const root = io.root ?? join(here, "..");
  const read = io.read ?? ((p) => readFileSync(p, "utf8"));
  const list =
    io.list ??
    (() =>
      git(
        [
          "ls-files",
          /*
           * UNTRACKED MANIFESTS ARE IN THE SUBJECT, and `git ls-files` omits them by default.
           * A branch that ADDS a workspace adds a package.json that is untracked until someone
           * commits, and a new workspace declaring a range an override violates is exactly the
           * case this check exists for -- so the version that cannot see new files is the one
           * that passes precisely when it matters. Found and patched three times in this repo
           * before anyone gated it (#209, #224, #856).
           */
          "--others",
          "--exclude-standard",
          "--cached",
          "package.json",
          "*/package.json",
          "**/package.json",
        ],
        root
      )
        .split("\n")
        .filter(Boolean));

  const paths = list();
  if (paths.length === 0)
    throw new Refusal(
      "no package.json files were listed, so the set of declaring manifests is unknown — " +
        "an empty subject here would be a claim about a tree this check never read"
    );

  const manifests = [];
  for (const p of paths) {
    let json;
    try {
      json = JSON.parse(read(join(root, p)));
    } catch (e) {
      throw new Refusal(`${p} could not be read or parsed (${e.message})`);
    }
    manifests.push({ path: p, json });
  }

  const rootManifest = manifests.find((m) => m.path === "package.json");
  if (!rootManifest)
    throw new Refusal(
      "the root package.json was not among the listed manifests"
    );

  const { present, entries } = overridesOf(rootManifest.json);
  const { violations, refused, decided, declaredOverrides } = evaluate(
    entries,
    manifests
  );

  reportSubject(
    declaredOverrides.length,
    "override(s) that a workspace manifest also declares"
  );

  const scope =
    `  ${Object.keys(entries).length} override(s) declared` +
    `${present ? "" : " (no `pnpm.overrides` block at all)"}, of which ` +
    `${declaredOverrides.length} are also declared by a manifest and therefore in subject.\n` +
    `  ${decided} decided, ${refused.length} refused.\n`;

  if (violations.length > 0) {
    console.error(
      `FAIL: ${violations.length} override(s) permit a version below what a declaring manifest requires.\n\n${scope}`
    );
    for (const v of violations) console.error(`  - ${v}\n`);
    if (refused.length > 0) {
      console.error(`  Not decided:\n`);
      for (const r of refused) console.error(`    - ${r}\n`);
    }
    return 1;
  }

  console.log(
    `PASS: no override permits a version below what a declaring manifest requires.\n\n${scope}`
  );
  if (refused.length > 0) {
    console.log(
      `  REFUSED rather than guessed — these are a named blind spot, not a pass:\n`
    );
    for (const r of refused) console.log(`    - ${r}`);
    console.log(
      `\n  \`semver\` is not resolvable from this repo's root, so entailment is decided over\n` +
        `  exact, \`>=\`, \`^\` and \`~\` only. Any other form is refused by construction.`
    );
  }
  return 0;
}

const invokedDirectly =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING: ${e.message}`);
      process.exit(2);
    }
    refuseUnanticipated(e);
  }
}
