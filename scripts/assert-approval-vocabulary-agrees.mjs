#!/usr/bin/env node
/**
 * assert-approval-vocabulary-agrees.mjs — the approval decision vocabulary we OFFER and the
 * one upstream can PRODUCE have not drifted apart.
 *
 * THE HAZARD. `requirements.txt` in both backends pins `langchain==1.3.18` — an EQUALITY.
 * The decision vocabulary lives on the far side of that pin: `HumanInTheLoopMiddleware`
 * expands `interrupt_on={tool: True}` into a concrete `allowed_decisions` list, and that list
 * is what our pass-through rungs put on the wire. We do not write it and cannot see it without
 * asking the installed package.
 *
 * THE PIN NARROWED THE HAZARD; IT DID NOT REMOVE IT. Until #669/#680 (a541f7fc, 2026-09-02)
 * these files declared `langchain>=0.3.0`, a FLOOR, and upstream could move the vocabulary
 * under an unchanged lockfile in any release the floor permitted. It cannot now. What remains
 * is that the vocabulary moves whenever the pin is BUMPED — a routine dependabot change whose
 * diff is one version number and whose effect on `allowed_decisions` is invisible in it. That
 * is the drift this check exists to catch, and a bump is a likelier arrival than a silent
 * upgrade ever was.
 *
 * (The header used to note that the same two files pinned deepagents and not langchain — #10's
 * "a floor of nothing... two different deepagents underneath" — and that the reasoning had been
 * applied to the dependency whose vocabulary does not matter rather than the one whose does.
 * That asymmetry is gone: langchain is pinned too. Recorded because the checker was designed
 * around it.)
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND ONLY ONE OF THEM BREAKS ANYTHING. This was the
 * design's near-miss: an equality check looked obviously right and would have been wrong.
 *
 *   WIDENING — upstream can produce a decision our parser REFUSES.   installed ⊄ parser
 *      The pass-through rungs advertise the installed set verbatim, the card renders a button
 *      for it, the user clicks, and the next request is refused by us. Real breakage. FAILS.
 *
 *   NARROWING — upstream drops a decision our parser still accepts.  parser ⊄ installed
 *      HARMLESS, measured end to end, and this is why it does not fail:
 *        · the card derives its controls from the payload — ApprovalPauseCard.tsx:90 is
 *          `ORDER.filter(d => allowedDecisions.includes(d))`, and schemas.ts:143 states
 *          `allowed_decisions` is "the card's ONLY source for which controls to render".
 *          A narrowed payload renders FEWER buttons; it never renders a dead one.
 *        · the authoring rung does not depend on the middleware at all — langgraph.py:110,
 *          "the gate is langgraph's own interrupt()" — so its offer is honoured by our own
 *          parser whatever upstream expands to.
 *      So a user on a narrowed install sees three buttons and every one works.
 *
 * WHY THAT DISTINCTION WAS JUDGED LOAD-BEARING — AND THE PREMISE HAS SINCE EXPIRED, WHICH IS
 * STATED HERE RATHER THAN QUIETLY ACTED ON. The original argument: langchain 1.2.11 expands
 * `True` to three decisions and 1.3.18 to four (#669), and BOTH satisfied the then-declared
 * `langchain>=0.3.0`. An equality check therefore went red on 1.2.11 — a SAFE, compliant
 * install — and a red with an obvious one-line repair is a mute button. It would be exempted
 * or pinned away by the first person who hit it, and the widening case would go with it.
 *
 * Under `langchain==1.3.18` there is no longer a compliant install that narrows: 1.2.11 does
 * not satisfy the pin. So the specific configuration this design protected does not exist in
 * this repo today, and the case for a subset check over an equality check no longer rests on
 * what it was built on.
 *
 * WHETHER IT SHOULD NARROW IS OPEN, AND IT IS NOT SETTLED HERE. Two things point the other
 * way and neither is decided by the pin: a developer venv is not required to match
 * requirements.txt (see the interpreter paragraph below — this machine carries three), and the
 * asymmetry argument above — that a narrowing is harmless end to end while a widening breaks a
 * request — is a claim about the PRODUCT, not about the version range, so the pin does not
 * touch it. The subset behaviour is therefore left exactly as it was. Changing it is a design
 * ruling and belongs to whoever makes design rulings, with this paragraph as the input.
 *
 * A narrowing is still REPORTED, on stdout, with the version that caused it — it is a real
 * change in what the product offers, and worth seeing. It is not a failure.
 *
 * WHY IT EXECUTES PYTHON RATHER THAN READING IT. Reading is how this goes wrong, and the
 * measured spread is wider than "a comment drifted". Every `allowed_decisions=[...]` in
 * langchain 1.3.18's `human_in_the_loop.py`:
 *
 *     line 170   2 entries   ["approve", "reject"]                        docstring example
 *     line 187   3 entries   ["approve", "edit", "reject"]                docstring example
 *     line 210   2 entries   ["approve", "reject"]                        docstring example
 *     line 263   4 entries   ["approve", "edit", "reject", "respond"]     THE BRANCH THAT RUNS
 *
 * A scan reaching for that literal meets a TWO-entry example first, and the one that runs is
 * last. Docstring examples are short ON PURPOSE, so they are not stale copies of the real
 * value — they were never meant to equal it, which is why they read as plausible rather than
 * as obviously broken.
 *
 * AND ABOVE ALL OF THEM, A SECOND HARDCODED COPY. At :51 sits
 * `DecisionType = Literal["approve","edit","reject","respond"]`, which answers a DIFFERENT
 * question: what the type permits, not what the `True` shorthand offers. Measured on 1.3.18,
 * `get_args` appears 0 times in the file and `DecisionType` is mentioned 3 times — its own
 * definition at :51 and two type annotations at :60 and :154 — never as a runtime value. So
 * the :263 expansion is NOT derived from the alias; it is a second copy of the same set, kept
 * in sync by hand.
 *
 * They agree on 1.2.11 (3 and 3) and on 1.3.18 (4 and 4) because both moved in the release
 * that added `respond` — one editor changing both. AGREEMENT BY MAINTENANCE IS NOT
 * DERIVATION, and it is the made-twice shape this repo has its own checkers for, sitting in a
 * library we depend on. A scan therefore has two wrong constructs to reach before the right
 * one, and the nearer of them is version-stable in a way the behaviour is not.
 *
 * ONE PREDICTION THAT DID NOT HOLD, recorded so it is not repeated as fact: the alias was
 * expected to list four on 1.2.11 while the expansion gave three, which would have made a
 * scan visibly wrong there. Measured on that install, the alias reads
 * ["approve","edit","reject"] and agrees — `respond` did not exist as a decision type in
 * 1.2.11 at all.
 *
 * Either way the probe is the answer: this constructs the middleware and reads back what
 * `True` actually resolved to, so no source construct can be mistaken for the behaviour.
 *
 * IDENTIFYING THE INSTALL IS PART OF THE CHECK, NOT A PRELUDE TO IT, AND THE PIN DOES NOT
 * CHANGE THAT. This machine carries langchain 1.2.17, 1.3.14 and 1.3.18 in different venvs.
 * `requirements.txt` names a version; it does not name a venv, and nothing makes the
 * interpreter on someone's PATH the one that file describes — so there is still no canonical
 * install to discover, and the reason is the venv rather than the range. The interpreter is
 * NAMED — by
 * --python or $LANGCHAIN_PYTHON, else the app venvs below — and when none can be used the
 * check REFUSES with exit 2 and prints every path it tried. "I could not determine the
 * installed vocabulary" must never spell the same as "the vocabulary agrees".
 *
 * Exit codes:  0 = the vocabularies agree   1 = they have drifted   2 = could not be determined
 *
 * Usage: node scripts/assert-approval-vocabulary-agrees.mjs [--cwd DIR] [--python PATH] [--json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Venvs to try when no interpreter is named. Order is stable so the report is reproducible. */
const CANDIDATE_PYTHONS = [
  "apps/fastapi-backend/.venv/bin/python",
  "apps/django-backend/.venv/bin/python",
];

/**
 * The probe. Constructs the middleware exactly as the pass-through rungs do — a bool `True`
 * in `interrupt_on` — and reports what that expanded to. It prints ONE line of JSON on stdout
 * and nothing else, so a partial or noisy result is a refusal rather than a parse.
 */
const PROBE = `
import json, sys
try:
    import langchain
    from langchain.agents.middleware import HumanInTheLoopMiddleware
except Exception as e:
    print(json.dumps({"ok": False, "why": "import failed: %s: %s" % (type(e).__name__, e)}))
    sys.exit(0)
try:
    m = HumanInTheLoopMiddleware(interrupt_on={"probe_tool": True})
    cfgs = getattr(m, "interrupt_on", None)
    if cfgs is None:
        cfgs = getattr(m, "_interrupt_on", None)
    got = cfgs["probe_tool"]["allowed_decisions"]
    print(json.dumps({"ok": True, "version": langchain.__version__, "decisions": list(got)}))
except Exception as e:
    print(json.dumps({"ok": False, "why": "probe failed: %s: %s" % (type(e).__name__, e)}))
`;

/** What our parser accepts, read from the shared module rather than restated here. */
export function parserVocabulary(cwd) {
  const path = join(cwd, "apps/fastapi-backend/ai_backends/_common.py");
  if (!existsSync(path)) return { ok: false, why: `not found: ${path}`, path };
  const src = readFileSync(path, "utf8");
  const m = src.match(/^_DECISION_TYPES\s*=\s*\(([^)]*)\)/m);
  if (!m)
    return { ok: false, why: `no _DECISION_TYPES assignment in ${path}`, path };
  const names = [...m[1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]);
  if (!names.length)
    return {
      ok: false,
      why: `_DECISION_TYPES parsed to nothing in ${path}`,
      path,
    };
  return { ok: true, decisions: names, path };
}

/**
 * THE AUTHORING RUNG MUST STAY DERIVED. langgraph.py offering `list(_DECISION_TYPES)` is what
 * makes claim A hold for it by construction; a literal list there would satisfy this checker
 * on the day it was written and drift the next. Its own comment says so — "two hardcoded lists
 * in one repo is how they come to differ" — and prose is not enforcement, which is why this
 * asserts it.
 */
export function authoringRungIsDerived(cwd) {
  const path = join(cwd, "apps/fastapi-backend/ai_backends/langgraph.py");
  if (!existsSync(path)) return { ok: false, why: `not found: ${path}`, path };
  const src = readFileSync(path, "utf8");
  const offers = [...src.matchAll(/"allowed_decisions"\s*:\s*([^,\n]+)/g)].map(
    (x) => x[1].trim()
  );
  if (!offers.length)
    return { ok: false, why: `no allowed_decisions offer in ${path}`, path };
  const literal = offers.find((o) => o.includes("[") || /["']/.test(o));
  if (literal) return { ok: true, derived: false, offender: literal, path };
  return { ok: true, derived: true, offers, path };
}

export function probeInstalled(pythonPath, execer = execFileSync) {
  let out;
  try {
    out = execer(pythonPath, ["-c", PROBE], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (e) {
    return {
      ok: false,
      why: `interpreter failed: ${e.shortMessage || e.message}`,
      python: pythonPath,
    };
  }
  const line = String(out).trim().split("\n").filter(Boolean).pop();
  if (!line)
    return { ok: false, why: "probe printed nothing", python: pythonPath };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      ok: false,
      why: `probe output was not JSON: ${line.slice(0, 120)}`,
      python: pythonPath,
    };
  }
  if (!parsed.ok) return { ok: false, why: parsed.why, python: pythonPath };
  if (!Array.isArray(parsed.decisions) || !parsed.decisions.length) {
    return {
      ok: false,
      why: "probe reported no decisions",
      python: pythonPath,
    };
  }
  return {
    ok: true,
    decisions: parsed.decisions,
    version: parsed.version,
    python: pythonPath,
  };
}

/** Resolve which interpreter to probe. Returns every path tried, so a refusal can name them. */
export function resolvePython(cwd, explicit, exists = existsSync) {
  const tried = [];
  const named = explicit || process.env.LANGCHAIN_PYTHON;
  if (named) {
    tried.push(named);
    return exists(named)
      ? { ok: true, python: named, tried }
      : { ok: false, tried };
  }
  for (const rel of CANDIDATE_PYTHONS) {
    const p = join(cwd, rel);
    tried.push(p);
    if (exists(p)) return { ok: true, python: p, tried };
  }
  return { ok: false, tried };
}

export function compare(installed, parser) {
  const inst = new Set(installed);
  const pars = new Set(parser);
  return {
    widened: installed.filter((d) => !pars.has(d)), // upstream has it, we would refuse it
    narrowed: parser.filter((d) => !inst.has(d)), // we offer it, upstream cannot produce it
  };
}

function main(argv = process.argv.slice(2)) {
  const cwdFlag = argv.indexOf("--cwd");
  const cwd = cwdFlag !== -1 ? argv[cwdFlag + 1] : ROOT;
  const pyFlag = argv.indexOf("--python");
  const explicit = pyFlag !== -1 ? argv[pyFlag + 1] : undefined;

  const parser = parserVocabulary(cwd);
  if (!parser.ok) {
    console.error(`CANNOT BE COMPUTED: ${parser.why}`);
    console.error("  A missing parser vocabulary is not an empty one.");
    process.exit(2);
  }

  const resolved = resolvePython(cwd, explicit);
  if (!resolved.ok) {
    console.error(
      "CANNOT BE COMPUTED: no interpreter with langchain was found."
    );
    console.error("  Tried, in order:");
    for (const t of resolved.tried) console.error(`    ${t}`);
    console.error("  Name one with --python PATH or $LANGCHAIN_PYTHON.");
    console.error(
      "  NOT a pass: the installed vocabulary is unknown, not agreed."
    );
    process.exit(2);
  }

  const installed = probeInstalled(resolved.python);
  if (!installed.ok) {
    console.error(`CANNOT BE COMPUTED: ${installed.why}`);
    console.error(`  Interpreter examined: ${installed.python}`);
    console.error(
      "  NOT a pass: the installed vocabulary is unknown, not agreed."
    );
    process.exit(2);
  }

  const authoring = authoringRungIsDerived(cwd);
  if (!authoring.ok) {
    console.error(`CANNOT BE COMPUTED: ${authoring.why}`);
    process.exit(2);
  }

  const { widened, narrowed } = compare(installed.decisions, parser.decisions);
  const failures = [];
  if (widened.length) {
    failures.push(
      `UPSTREAM WIDENED. langchain ${
        installed.version
      } can now produce ${JSON.stringify(widened)}, ` +
        `which parse_approval_decisions does not accept.\n` +
        `    The pass-through rungs advertise the installed set verbatim, so a client that picks ` +
        `one of these is refused by us on the way back.\n` +
        `    Fix: add it to _DECISION_TYPES in ${parser.path} and teach the parser to honour it, ` +
        `or stop advertising it.`
    );
  }
  const notes = [];
  if (narrowed.length) {
    notes.push(
      `NARROWED (not a failure). Our parser accepts ${JSON.stringify(
        narrowed
      )}, which ` +
        `langchain ${installed.version} does not expand \`True\` into.\n` +
        `    Harmless: the card renders only what the payload offers (ApprovalPauseCard.tsx:90), ` +
        `so a user here sees fewer controls and every one is honoured.\n` +
        `    Reported because it changes what the product offers, not because it is broken.`
    );
  }
  if (!authoring.derived) {
    failures.push(
      `THE AUTHORING RUNG STOPPED DERIVING ITS OFFER. ${authoring.path} advertises the literal ` +
        `${authoring.offender} instead of list(_DECISION_TYPES).\n` +
        `    Its own comment gives the reason: "two hardcoded lists in one repo is how they come ` +
        `to differ".`
    );
  }

  const subject =
    `installed ${JSON.stringify(installed.decisions)} (langchain ${
      installed.version
    }, ` +
    `${installed.python})\n  parser    ${JSON.stringify(parser.decisions)} (${
      parser.path
    })`;

  if (failures.length) {
    console.error("APPROVAL VOCABULARY HAS DRIFTED\n");
    console.error(`  ${subject}\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    for (const n of notes) console.error(`  ${n}\n`);
    process.exit(1);
  }

  console.log(`approval vocabulary is compatible:\n  ${subject}`);
  console.log(
    `  authoring rung offers ${authoring.offers.join(
      ", "
    )} — derived, not a literal`
  );
  console.log(
    `  every decision upstream can produce is one the parser accepts`
  );
  for (const n of notes) console.log(`\n  ${n}`);
}

if (invokedAsProgram(import.meta.url)) main();
export { main, PROBE, CANDIDATE_PYTHONS };
