#!/usr/bin/env node
/**
 * A CENSUS `why` THAT QUOTES A REGISTRATION MUST QUOTE IT CORRECTLY (#906).
 *
 * `eject-classify.mjs` writes reasons that RESTATE a declaration from
 * `scripts/checks.json`:
 *
 *     declares needs:board-read — its subject is read from outside the tree, ...
 *     declares subjectKind:external — its subject is not in the tree, ...
 *
 * Two files then hold the same fact and NOTHING ASSERTS THEY AGREE. The census
 * is generated, the registry is hand-written, and they are edited by different
 * people at different times for different reasons. A census row can therefore
 * say a checker "declares subjectKind:external" about a checker whose
 * registration says nothing of the kind, and every consumer downstream reads the
 * census sentence rather than the registry.
 *
 * THIS IS THE DECLARED-HERE-CONSUMED-THERE SHAPE, and it is why the guard is
 * cheap: the census sentence is not evidence, it is a COPY. Verifying a copy
 * against its source needs no judgement and no ruling.
 *
 * WHAT IT DOES NOT ASSERT, said explicitly because the omission is deliberate
 * and someone will otherwise assume it is covered. It does NOT check that a
 * checker declaring a channel also declares an external subject. `needs` and
 * `subjectKind` are INDEPENDENT (#844): `action-pin-comments` declares
 * needs:action-tags and subjectKind:tree, and its census row says its subject
 * "is read from outside the tree" — a sentence the registry contradicts. That
 * contradiction is real and it is #844's ruling, not this check's business.
 * Asserting it here would make this guard fail on main today and would smuggle a
 * ruling into a consistency check. What is checked here is only that a quoted
 * declaration matches the declaration it quotes.
 *
 * TWO HALVES, AND NEITHER ENCODES THE CLASSIFIER'S BRANCH ORDER. `contradictions` checks
 * that every claim present quotes its registration correctly; `silentObligations` checks
 * that every registration owing a claim has one. Together that is a bijection between the
 * registrations obliged to claim and the census rows that do — which is the property a
 * future maintainer would break by folding either half into the other.
 *
 * THE HOLE THIS LEAVES, BOUNDED SO IT CAN BE ACTED ON. Two checks declare BOTH a channel
 * and an external subject, and the classifier emits one claim for them. If it emitted the
 * WRONG one of the two, nothing here would notice: existence holds because a claim is
 * present, and content holds because a wrong-branch claim still quotes a declaration the
 * registry really carries. Catching that needs the branch ORDER, which lives in
 * eject-classify.mjs and is deliberately not copied here. That failure requires a
 * deliberate edit to the classifier, where a reviewer is looking; the failure these halves
 * DO catch is an incidental reword of a template string, which nobody is watching.
 *
 * Exit 0 every quoted declaration matches the registry · 1 at least one does
 * not · 2 the question could not be asked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `--cwd DIR` so the proof can drive this over planted trees. Without it the
 * only negative case available is mutating the real repo, which cannot be left
 * in the suite.
 */
function rootFrom(argv) {
  const i = argv.indexOf("--cwd");
  return i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : DEFAULT_ROOT;
}

/**
 * The reasons `eject-classify.mjs` opens by restating a registration. Anchored
 * at the start so a `why` that merely MENTIONS one of these words in prose is
 * not mistaken for a claim about the registry.
 *
 * THE SEPARATOR IS AN EM DASH AND THE VALUE IS GREEDY, BOTH DELIBERATELY. The
 * first draft used a lazy `(\S+?)` before `[—-]`, and every declared value in
 * this repo is hyphenated — board-read, merge-commit, action-tags. It matched
 * `board` and read the hyphen INSIDE the value as the separator, reporting seven
 * contradictions that did not exist, each with a plausible message naming a real
 * check. A broken pattern returning a confident list is worse than one returning
 * nothing, because nothing announces itself.
 *
 * Strict rather than tolerant: this `why` is composed by eject-classify.mjs in a
 * known shape, so if that wording changes this stops matching, the claim count
 * falls to zero and the floor refuses. That is the loud failure; a tolerant
 * pattern would quietly verify fewer rows every year.
 */
export const PREFIX = "declares ";

export const CLAIM = /^declares (needs|subjectKind):(\S+) \u2014 /u;

/** Every census row whose reason quotes a registration, as {name, field, value}. */
export function claimsFrom(census) {
  const checkers = census?.checkers;
  if (!checkers || typeof checkers !== "object")
    throw new Error(
      "the census has no `checkers` object, so no reason could be read. An empty " +
        "claim set and an unreadable census are the same value and mean opposite things."
    );
  const out = [];
  for (const [name, row] of Object.entries(checkers)) {
    const why = String(row?.why ?? "");
    const m = CLAIM.exec(why);
    if (m) {
      out.push({ name, field: m[1], value: m[2] });
      continue;
    }
    /*
     * A REASON THAT ANNOUNCES A CLAIM AND DOES NOT PARSE IS "COULD NOT ASK", NOT
     * "NOTHING TO ASK". Skipping it silently narrows the subject by one and the
     * floor cannot see that: the floor is 1, so it only fires when EVERY row
     * stops parsing. A partial wording change in eject-classify.mjs — the likelier
     * edit — takes the claim set from 8 to 7 and nothing says so. That is this
     * check's own defect class occurring inside this check.
     */
    if (why.startsWith(PREFIX))
      throw new Error(
        `${name}: its census reason begins "${PREFIX}" but does not parse as a ` +
          `quoted declaration, so it was neither verified nor reported. The reason ` +
          `reads: ${JSON.stringify(
            why.slice(0, 90)
          )}. Either eject-classify.mjs ` +
          `changed the wording and CLAIM must follow it, or this row is malformed.`
      );
  }
  return out;
}

/**
 * The checks whose registration OBLIGES a claim, as a Set of names.
 *
 * `eject-classify.mjs` returns not-tree-derived down two branches: one for a declared
 * `needs`, one for `subjectKind: "external"`. Either way the reason it composes opens by
 * quoting the declaration, so any registration matching EITHER condition must appear in
 * the census as a claim.
 *
 * DELIBERATELY A UNION AND NOT A PRECEDENCE. Two checks declare both, and the classifier
 * emits only one claim for them — `needs` wins, because that branch is first. Predicting
 * WHICH claim would mean encoding the classifier's branch ORDER here, and that rule lives
 * in eject-classify.mjs and nowhere else. Copying it into a checker would create two facts
 * that must agree with nothing asserting they do, which is the defect this whole file
 * exists to catch. So this asks only whether a claim EXISTS; `contradictions` already
 * checks that whatever claim is present quotes its registration correctly.
 */
export function mustClaim(registry) {
  if (!registry || !Array.isArray(registry.checks))
    throw new Error(
      "scripts/checks.json has no `checks` array, so the set of checks obliged to " +
        "claim could not be built. An empty obligation set would make every silence look correct."
    );
  return new Set(
    registry.checks
      .filter((c) => c.needs || c.subjectKind === "external")
      .map((c) => c.name)
  );
}

/** Registration by check name. Throws rather than returning {} — see needsFrom. */
export function registrationsFrom(registry) {
  if (!registry || !Array.isArray(registry.checks))
    throw new Error(
      "scripts/checks.json has no `checks` array, so no registration could be " +
        "read. Every quoted declaration would then appear unverifiable rather " +
        "than wrong, which is the silent direction."
    );
  return Object.fromEntries(registry.checks.map((r) => [r.name, r]));
}

/** The claims whose quoted declaration the registry does not support. */
export function contradictions(claims, registrations) {
  const problems = [];
  for (const { name, field, value } of claims) {
    const reg = registrations[name];
    if (!reg) {
      problems.push(
        `${name}: its census reason quotes \`${field}: "${value}"\`, but the check is ` +
          `NOT REGISTERED at all. The sentence describes a declaration that does not exist.`
      );
      continue;
    }
    const actual = reg[field];
    if (actual !== value)
      problems.push(
        `${name}: its census reason says \`${field}: "${value}"\`, but checks.json ` +
          `declares ${
            actual === undefined
              ? "NOTHING for that field"
              : `\`${field}: ${JSON.stringify(actual)}\``
          }. ` +
          `Consumers read the census sentence, so the census is the one that misleads.`
      );
  }
  return problems;
}

/** Registrations obliged to claim that the census is silent about. */
export function silentObligations(mustClaimNames, claims) {
  const claimed = new Set(claims.map((c) => c.name));
  return [...mustClaimNames]
    .filter((n) => !claimed.has(n))
    .sort()
    .map(
      (n) =>
        `${n}: its registration declares a channel or an external subject, so the ` +
        `classifier owes a reason quoting that declaration — and the census carries none. ` +
        `Either the row is missing, or eject-classify.mjs changed the wording its reasons ` +
        `open with and this check no longer recognises them.`
    );
}

function refuse(what, err) {
  console.error(`REFUSE: ${what}`);
  if (err) console.error(`        ${err.message}`);
  process.exit(2);
}

function main(root = rootFrom(process.argv.slice(2))) {
  const ROOT = root;
  let registry, census;
  try {
    registry = JSON.parse(
      readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
    );
  } catch (e) {
    refuse("scripts/checks.json could not be read or parsed.", e);
  }
  try {
    census = JSON.parse(
      readFileSync(join(ROOT, "scripts/eject-subject-census.json"), "utf8")
    );
  } catch (e) {
    refuse("scripts/eject-subject-census.json could not be read or parsed.", e);
  }

  let claims, registrations;
  try {
    claims = claimsFrom(census);
    registrations = registrationsFrom(registry);
  } catch (e) {
    refuse("a declaration set could not be built.", e);
  }

  let obliged;
  try {
    obliged = mustClaim(registry);
  } catch (e) {
    refuse("the set of checks obliged to claim could not be built.", e);
  }
  const problems = [
    ...contradictions(claims, registrations),
    ...silentObligations(obliged, claims),
  ];
  if (problems.length) {
    console.error(
      `FAIL: ${problems.length} census reason(s) quote a registration the registry does not make:`
    );
    for (const p of problems) console.error(`   - ${p}`);
    console.error(
      `\n      The census is REGENERATED and the registry is HAND-WRITTEN, so the repair is\n` +
        `      almost never to edit the census: fix the registration, or fix the classifier\n` +
        `      that composed the sentence, then re-run \`pnpm eject-audit\`.`
    );
    process.exit(1);
  }

  reportSubject(
    claims.length,
    "census reason(s) quoting a registration, against " +
      `${obliged.size} registration(s) obliged to carry one`
  );
  for (const c of claims)
    console.log(`  ${c.name}: ${c.field}="${c.value}" — matches checks.json`);
  console.log(
    `\nPASS: every census reason that quotes a registration quotes it correctly.\n` +
      `      This does NOT assert the classification is right — only that the sentence\n` +
      `      and the declaration it copies agree (#906).`
  );
}

if (invokedAsProgram(import.meta.url)) main();
