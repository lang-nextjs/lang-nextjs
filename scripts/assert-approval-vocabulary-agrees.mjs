#!/usr/bin/env node
/**
 * assert-approval-vocabulary-agrees.mjs — the approval decision vocabulary we OFFER and the
 * one upstream can PRODUCE have not drifted apart.
 *
 * THE HAZARD, AND IT IS AUTHORISED BY OUR OWN DECLARATION. `requirements.txt` pins
 * `langchain>=0.3.0` — a FLOOR. The decision vocabulary lives inside that floor:
 * `HumanInTheLoopMiddleware` expands `interrupt_on={tool: True}` into a concrete
 * `allowed_decisions` list, and that list is what our pass-through rungs put on the wire.
 * Upstream may widen or narrow it in any release the floor permits, and nothing in this repo
 * would go red. The same two files PIN deepagents and explain why (#10: "a floor of nothing...
 * two different deepagents underneath") — the reasoning was done and applied to the dependency
 * whose vocabulary does not matter, and not to the one whose does.
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
 * WHY THAT DISTINCTION IS LOAD-BEARING RATHER THAN PEDANTRY. langchain 1.2.11 expands `True`
 * to three decisions and 1.3.18 to four (#669); BOTH satisfy `langchain>=0.3.0`. An equality
 * check therefore goes red on 1.2.11 — a SAFE, compliant install — and a red with an obvious
 * one-line repair is a mute button. It would be exempted or pinned away by the first person
 * who hit it, and the widening case would go with it. A subset check stays green on 1.2.11
 * correctly and fires only on the configuration that actually breaks.
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
 * THE NEARBY CONSTRUCT THAT IS *NOT* THE HAZARD, checked rather than assumed. `DecisionType =
 * Literal[...]` sits above all of these and answers a different question — what the type
 * PERMITS, not what `True` OFFERS. It was proposed as the more dangerous trap on the theory
 * that it would list four on 1.2.11 where the expansion gives three. Measured on that install,
 * it does not: the alias there reads ["approve","edit","reject"] and agrees with the
 * expansion, because `respond` did not exist as a decision type in 1.2.11 at all. So the alias
 * agreed with the truth on both versions available to test, and the docstring literal is the
 * hazard that actually bites.
 *
 * Either way the probe is the answer: this constructs the middleware and reads back what
 * `True` actually resolved to, so no source construct can be mistaken for the behaviour.
 *
 * IDENTIFYING THE INSTALL IS PART OF THE CHECK, NOT A PRELUDE TO IT. This machine carries
 * langchain 1.2.17, 1.3.14 and 1.3.18 in different venvs, and every one satisfies
 * `>=0.3.0`; there is no canonical install to discover. So the interpreter is NAMED — by
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
  if (!m) return { ok: false, why: `no _DECISION_TYPES assignment in ${path}`, path };
  const names = [...m[1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]);
  if (!names.length) return { ok: false, why: `_DECISION_TYPES parsed to nothing in ${path}`, path };
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
  const offers = [...src.matchAll(/"allowed_decisions"\s*:\s*([^,\n]+)/g)].map((x) => x[1].trim());
  if (!offers.length) return { ok: false, why: `no allowed_decisions offer in ${path}`, path };
  const literal = offers.find((o) => o.includes("[") || /["']/.test(o));
  if (literal) return { ok: true, derived: false, offender: literal, path };
  return { ok: true, derived: true, offers, path };
}

export function probeInstalled(pythonPath, execer = execFileSync) {
  let out;
  try {
    out = execer(pythonPath, ["-c", PROBE], { encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    return { ok: false, why: `interpreter failed: ${e.shortMessage || e.message}`, python: pythonPath };
  }
  const line = String(out).trim().split("\n").filter(Boolean).pop();
  if (!line) return { ok: false, why: "probe printed nothing", python: pythonPath };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, why: `probe output was not JSON: ${line.slice(0, 120)}`, python: pythonPath };
  }
  if (!parsed.ok) return { ok: false, why: parsed.why, python: pythonPath };
  if (!Array.isArray(parsed.decisions) || !parsed.decisions.length) {
    return { ok: false, why: "probe reported no decisions", python: pythonPath };
  }
  return { ok: true, decisions: parsed.decisions, version: parsed.version, python: pythonPath };
}

/** Resolve which interpreter to probe. Returns every path tried, so a refusal can name them. */
export function resolvePython(cwd, explicit, exists = existsSync) {
  const tried = [];
  const named = explicit || process.env.LANGCHAIN_PYTHON;
  if (named) {
    tried.push(named);
    return exists(named) ? { ok: true, python: named, tried } : { ok: false, tried };
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
    console.error("CANNOT BE COMPUTED: no interpreter with langchain was found.");
    console.error("  Tried, in order:");
    for (const t of resolved.tried) console.error(`    ${t}`);
    console.error("  Name one with --python PATH or $LANGCHAIN_PYTHON.");
    console.error("  NOT a pass: the installed vocabulary is unknown, not agreed.");
    process.exit(2);
  }

  const installed = probeInstalled(resolved.python);
  if (!installed.ok) {
    console.error(`CANNOT BE COMPUTED: ${installed.why}`);
    console.error(`  Interpreter examined: ${installed.python}`);
    console.error("  NOT a pass: the installed vocabulary is unknown, not agreed.");
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
      `UPSTREAM WIDENED. langchain ${installed.version} can now produce ${JSON.stringify(widened)}, ` +
        `which parse_approval_decisions does not accept.\n` +
        `    The pass-through rungs advertise the installed set verbatim, so a client that picks ` +
        `one of these is refused by us on the way back.\n` +
        `    Fix: add it to _DECISION_TYPES in ${parser.path} and teach the parser to honour it, ` +
        `or stop advertising it.`,
    );
  }
  const notes = [];
  if (narrowed.length) {
    notes.push(
      `NARROWED (not a failure). Our parser accepts ${JSON.stringify(narrowed)}, which ` +
        `langchain ${installed.version} does not expand \`True\` into.\n` +
        `    Harmless: the card renders only what the payload offers (ApprovalPauseCard.tsx:90), ` +
        `so a user here sees fewer controls and every one is honoured.\n` +
        `    Reported because it changes what the product offers, not because it is broken.`,
    );
  }
  if (!authoring.derived) {
    failures.push(
      `THE AUTHORING RUNG STOPPED DERIVING ITS OFFER. ${authoring.path} advertises the literal ` +
        `${authoring.offender} instead of list(_DECISION_TYPES).\n` +
        `    Its own comment gives the reason: "two hardcoded lists in one repo is how they come ` +
        `to differ".`,
    );
  }

  const subject =
    `installed ${JSON.stringify(installed.decisions)} (langchain ${installed.version}, ` +
    `${installed.python})\n  parser    ${JSON.stringify(parser.decisions)} (${parser.path})`;

  if (failures.length) {
    console.error("APPROVAL VOCABULARY HAS DRIFTED\n");
    console.error(`  ${subject}\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    for (const n of notes) console.error(`  ${n}\n`);
    process.exit(1);
  }

  console.log(`approval vocabulary is compatible:\n  ${subject}`);
  console.log(`  authoring rung offers ${authoring.offers.join(", ")} — derived, not a literal`);
  console.log(`  every decision upstream can produce is one the parser accepts`);
  for (const n of notes) console.log(`\n  ${n}`);
}

if (invokedAsProgram(import.meta.url)) main();
export { main, PROBE, CANDIDATE_PYTHONS };
