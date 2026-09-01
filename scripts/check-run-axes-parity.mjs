#!/usr/bin/env node
/**
 * Both runtimes record what a run IS, identically (#118, #171).
 *
 * `set_run_axes` / `langfuse_trace_metadata` decide the tags and the session on
 * every trace. The fastapi plane has had them since #118; the django plane had
 * NEITHER, so every django trace arrived untagged and unsessioned while its
 * fastapi twin was filterable. "Compare the same framework across two runtimes"
 * — the comparison this repo exists to make — silently covered half the fleet,
 * and the half it covered was the one anyone looking would check first.
 *
 * WHY A SOURCE CHECK. The django backend has no test harness and `pnpm` cannot
 * see it — it has no package.json. scripts/check-langfuse-wiring.mjs works
 * around the same constraint the same way, and says so. The fastapi behaviour
 * IS unit-tested (tests/test_run_session.py); what this adds is that the other
 * plane cannot quietly diverge from the plane those tests cover.
 *
 * IDENTICAL, NOT MERELY PRESENT. Two implementations that both exist and differ
 * is the failure mode that produced #232, #247/#302 and the subagent reporting
 * fix — each had to be made twice, and each was found only when someone
 * compared. Byte equality is the only version of "the same" that cannot drift.
 *
 * Closed by construction:
 *   * a missing source file is a HARD FAILURE, not "nothing to compare"
 *   * a missing function is a HARD FAILURE, not a skipped comparison
 *   * finding ZERO functions to compare is a HARD FAILURE — a check with no
 *     subject is vacuous, and reads as coverage
 * Proven by scripts/check-run-axes-parity.selftest.mjs, which CI runs first.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PLANES = {
  fastapi: "apps/fastapi-backend/ai_backends/_common.py",
  django: "apps/django-backend/deepagents_backend/ai_backends/_common.py",
};

// Dispatches that must record the axes, including the session.
const DISPATCH = {
  fastapi: "apps/fastapi-backend/main.py",
  django: "apps/django-backend/deepagents_backend/views.py",
};

// `parse_approval_policy` / `interrupt_on_for` are here rather than in a checker of
// their own (#261): the approval policy arrives on the wire and each plane inverts it
// against its own tool inventory, so the two implementations diverging is the same
// "made twice" failure this file already exists to catch — and with node-backend it
// would be three times.
//
// `_error_origin` joins them for #400. It decides whether a failed run was the
// PROVIDER's fault or ours, and the live-transport job's outcome turns on its
// answer — so the two planes disagreeing about it would mean the same failure is
// presented as an upstream outage on one runtime and a transport defect on the
// other. That is the exact class of divergence this checker exists for.
export const SHARED = [
  "set_run_axes",
  // Moved out of langchain.py in #332 C2: it takes a graph and a config, names
  // no framework, and every gated rung needs exactly it. Two rungs gate now, so
  // the alternative was a second copy — the "made twice" shape this file exists
  // to catch. Listed here so the two planes' copies are held identical.
  "_pending_approval_events",
  // Split out of _pending_approval_events in #332 step C4. Two rungs put the
  // pause on the wire as an SSE event an adapter converts; the deepagents rung
  // emits AI SDK v6 parts directly and has no converting adapter, so it needs
  // the same STATE READ and a different frame. The read is the part that carries
  // the subtle cases — no checkpointer, no interrupts, a payload that is not a
  // dict — so it is shared and both planes' copies are held identical here.
  "_pending_interrupts",
  "_pending_approval_parts",
  "langfuse_trace_metadata",
  "parse_approval_policy",
  "interrupt_on_for",
  "_error_origin",
  "set_approval_allowlist",
  "approval_interrupt_on",
  "derive_thread_id",
  "set_thread_id",
  "approval_thread_config",
  "parse_approval_decisions",
  "set_approval_decisions",
  "approval_resume_command",
  /*
   * THE WIRE FORMAT ITSELF (#527, and E2E-02's parity half).
   *
   * `guarded_stream` is the function that EMITS the SSE frames — the text-end
   * frame, the error payload, and the `data:` passthrough — and `_error_code`
   * shapes the payload it emits on failure. E2E-02 claims the two planes emit
   * the SAME wire format; measured, all 27 function bodies in the two
   * `_common.py` files are identical and the whole diff is 22 lines of comments
   * plus one import position. So the claim is TRUE and nothing was holding it.
   *
   * The file itself records this pair diverging before, on this very concern:
   * django's own comment says "#247 fixed this on the fastapi plane; THIS PLANE
   * IS A SEPARATE IMPLEMENTATION AND KEPT THE DEFECT", found when the
   * live-transport job ran rather than by a gate.
   *
   * NOTE WHAT THIS DOES AND DOES NOT GIVE. Parity is not proof: both planes
   * could be identically wrong. fastapi's side IS proven behaviourally by
   * tests/test_response_wire_format.py and django's by tests/ (#508), so what
   * this adds is that neither can drift away from the plane the other's tests
   * cover. Validating either against docs/sse-frame-schema.json is a different
   * question and is #550.
   */
  "_error_code",
  "guarded_stream",
  /*
   * THE THREE THIS LIST FORGOT, found by the totality guard below rather than by reading.
   *
   * `increment`, `get_counter` and `web_search` sit at the TOP of `_common.py`, above the
   * `def make_llm(` anchor that check-langfuse-wiring's lockstep comparison starts from. So
   * they were named by no list and covered by no span: the two planes could have diverged on
   * the shared tool the agents actually call, and every gate in this repo would have stayed
   * green. Measured before adding: `increment` and `get_counter` are byte-identical and
   * `web_search` differs only by a comment block, so this closes a hole rather than papering
   * over a divergence — it lands green because the property already held, not because the
   * comparison was relaxed to let it.
   */
  "increment",
  "get_counter",
  "web_search",
  /*
   * THE LLM AND OBSERVABILITY HELPERS, and why they are named HERE rather than excused to
   * another file's comparison.
   *
   * These nine do already sit inside check-langfuse-wiring's lockstep check, which compares
   * `_common.py` byte-for-byte FROM `def make_llm(` ONWARD. Excusing them on that basis was the
   * alternative, and it is the worse one: that span is anchored to a position, so a function
   * moved above `make_llm` leaves the span silently while an exemption here would go on citing
   * it. An exception whose reason can stop being true without the exception noticing is the
   * mute button this guard exists to make impossible.
   *
   * Naming them is also not redundant, because the two instruments differ in what they can see.
   * Lockstep compares a CONTIGUOUS SPAN and so is sensitive to order and to anything between the
   * functions; this compares NAMED BODIES and so survives reordering. Reordering one plane's
   * file breaks the span and not the bodies — one of them reports a real divergence and the
   * other reports a reshuffle, and it is worth being able to tell those apart.
   */
  "make_llm",
  "llm_status",
  "_env_flag",
  "langfuse_configured",
  "langfuse_callbacks",
  "langfuse_config",
  "langfuse_probe",
  "_langfuse_detail",
  "observability_status",
];

/*
 * THE PER-RUNG BACKENDS, AND THE DECLARATION THEY READ (#449 invariant I1, #332).
 *
 * The functions above live in `_common.py`. `stream_chat_react` does not — it is
 * per-backend by construction, and it is where each plane decides whether to
 * build a GATED graph.
 *
 * WHAT THIS PAIR USED TO MISS, MEASURED RATHER THAN REASONED ABOUT. Until #332's
 * step C this compared `stream_chat_react` and nothing else, and that function
 * contains `gated = "react" in GATED_TOPOLOGIES` — it READS the declaration, it
 * does not contain it. So the function stayed byte-identical on both planes while
 * the constant it reads diverged, and the check passed. That was not hypothetical:
 * after #332 step B armed fastapi and before C1 armed django, main shipped
 * `frozenset({"react"})` on one plane and `frozenset()` on the other, and this
 * script exited 0 while reporting "including the gated-topology builder" — a
 * success line naming the subject whose state it could not see.
 *
 * The comparison therefore covers the DECLARATION as well as its reader. They are
 * different claims: identical readers mean the planes decide gating the same WAY,
 * identical declarations mean they decide it for the same TOPOLOGIES, and #449's
 * ruling needs both.
 *
 * WHY THREE MODULES AND NOT ONE. The same reasoning applies per rung and only
 * langchain was ever opened, so langgraph and deepagents were unexamined — and
 * #332's plan calls their second plane a "mirror" while no gate could check the
 * mirroring. All three were already byte-identical across planes when this
 * widened, so what was missing was the coverage and not the property.
 *
 * PRESENT MODULES ARE DISCOVERED, NOT NAMED. This file survives every `pnpm
 * eject`; langgraph.py and deepagents.py do not, because a fork below their rung
 * prunes them. A shared checker opening a rung-owned path by name is green on the
 * ladder and dies on a missing file in a fork — the class filed as #588, which
 * this script would otherwise have become a fourth instance of. langchain is rung
 * 1 and survives every eject, so it is REQUIRED: that floor is what stops
 * discovery from degrading into a check that finds nothing and passes.
 *
 * WHY IT BELONGS IN A PARITY CHECK RATHER THAN A TEST. #449 was ruled "no bypass"
 * on one property: an upstream-gated call emits no tool frames, so it can never
 * reach the proxy gate's only trigger. `test_gated_emits_no_tool_frames.py` asserts
 * that BEHAVIOURALLY against fastapi. Django has had its own Python harness since
 * #532 — the sentence that stood here said it had none, and outlived that being
 * true — but the gated behaviour is still asserted on one plane only, so the
 * identity is what carries the ruling to the other.
 *
 * That is weaker than running the behaviour twice and is written down as such,
 * rather than left for a reader to assume parity means proof.
 */
const BACKEND_PLANES = {
  langchain: {
    fastapi: "apps/fastapi-backend/ai_backends/langchain.py",
    django: "apps/django-backend/deepagents_backend/ai_backends/langchain.py",
  },
  langgraph: {
    fastapi: "apps/fastapi-backend/ai_backends/langgraph.py",
    django: "apps/django-backend/deepagents_backend/ai_backends/langgraph.py",
  },
  deepagents: {
    fastapi: "apps/fastapi-backend/ai_backends/deepagents.py",
    django: "apps/django-backend/deepagents_backend/ai_backends/deepagents.py",
  },
};

// Rung 1. Present in every fork, so its absence is a defect rather than an eject.
const REQUIRED_BACKEND = "langchain";

export const SHARED_TOPOLOGY = ["stream_chat_react"];

// Compared as source text, not as function bodies — these are module-level
// constants, and the entire point is that the function reading them can be
// identical while they differ.
export const SHARED_DECLARATION = ["GATED_TOPOLOGIES"];

/**
 * The runtimes rungs.json declares, mapped to the directory their adapters live in.
 *
 * DELIBERATELY A LOCAL COPY of the reader in check-langfuse-wiring.mjs rather than an import.
 * These two guards were asked for as independent changes so they can land independently, and a
 * shared helper would make one a prerequisite of the other. If both land, folding them together
 * is a follow-up with the branches already merged — not a coupling introduced here.
 */
export function declaredPlanes(root) {
  const manifest = JSON.parse(readFileSync(join(root, "rungs.json"), "utf8"));
  const ids = new Set();
  for (const rung of manifest.rungs ?? [])
    for (const [id, cfg] of Object.entries(rung.runtimes ?? {}))
      if (cfg?.topologiesSource) ids.add(id);
  return ids;
}

/*
 * PLANES THIS COMPARISON DOES NOT REACH, and node is not the same case as it is in
 * check-langfuse-wiring. THE DIFFERENCE MATTERS AND IS WRITTEN DOWN RATHER THAN GLOSSED.
 *
 * There, node genuinely had nothing to check: it attaches no Langfuse handler and says so.
 * HERE IT HAS A REAL IMPLEMENTATION — apps/node-backend/src/common/runAxes.ts defines
 * `currentRunAxes` / `traceMetadata` / `withRunAxes`, and runAxes.test.ts pins its behaviour.
 * So node is not unchecked; it is checked by a DIFFERENT INSTRUMENT.
 *
 * The instrument this file uses is code identity, and code identity does not cross languages:
 * there is no sense in which TypeScript can be byte-equal to Python. That is a limit of the
 * instrument, not a property of node.
 *
 * WHAT IS THEREFORE STILL UNVERIFIED, stated plainly so the exemption does not read as
 * coverage: nothing anywhere compares node's tag vocabulary or session derivation to the
 * Python planes'. node's tests prove node agrees with NODE; the three-runtime parity this
 * file's first sentence claims is verified for two of the three. Closing that needs a
 * behavioural conformance check against a shared schema, which is a different instrument and
 * a different issue — it is not something this guard can do, and it should not be filed as
 * done because this guard is green.
 */
const PLANES_NOT_COMPARED = {
  node: {
    why:
      "implements the axes in TypeScript (src/common/runAxes.ts, pinned by runAxes.test.ts); " +
      "this file's instrument is code identity, which cannot cross languages",
    evidence: "apps/node-backend/src/common/runAxes.ts",
    // The exemption's whole claim is "checked by another instrument". If that instrument
    // disappears, the claim is false and the exemption must not survive it.
    alsoRequires: "apps/node-backend/src/common/runAxes.test.ts",
  },
};

/*
 * Functions in `_common.py` deliberately left out of SHARED, with reasons. EMPTY, AND THAT IS
 * THE POINT: every top-level def on both planes is now compared, so there is no entry here to
 * argue about. An addition to this object is a claim that some shared function may differ
 * between the runtimes without anyone minding, which is exactly the claim #118 and #247 were.
 */
const FUNCTIONS_NOT_COMPARED = {};

/** Top-level `def`s in source order. */
function topLevelDefs(src) {
  return [...src.matchAll(/^(?:async )?def ([A-Za-z_][A-Za-z0-9_]*)/gm)].map(
    (m) => m[1]
  );
}

/**
 * THE LISTS ABOVE MUST COVER THE WORLD.
 *
 * PLANES, DISPATCH and SHARED are literals, and a literal subject set answers "did the things
 * I named agree" while the success line says "the two runtimes record runs identically". Those
 * are the same sentence only if the names are all of them, and nothing here checked that. A
 * plane added to rungs.json, or a function added to both `_common.py` files, was simply not in
 * the comparison — and the PASS line did not get quieter.
 */
export function checkSubjectTotality(root) {
  const problems = [];

  // ── planes ────────────────────────────────────────────────────────────────────────────────
  const declared = declaredPlanes(root);
  if (declared.size === 0)
    return [
      "TOTALITY: rungs.json declared ZERO runtimes, so 'every plane is compared' is true of no " +
        "planes. The manifest moved or its shape changed; either way this measured nothing.",
    ];

  for (const id of declared) {
    const compared = id in PLANES;
    const exempt = PLANES_NOT_COMPARED[id];
    if (compared && exempt)
      problems.push(
        `TOTALITY: plane "${id}" is both in PLANES and in PLANES_NOT_COMPARED. One of them is ` +
          `wrong, and which one decides whether its axes are compared at all.`
      );
    if (!compared && !exempt)
      problems.push(
        `TOTALITY: rungs.json declares runtime "${id}", which this file neither compares nor ` +
          `records a reason for skipping. "Both runtimes record runs identically" is a claim ` +
          `about the fleet, and a third plane outside PLANES makes it a claim about a subset ` +
          `while the PASS line still reads as the whole. Add it to PLANES and DISPATCH, or to ` +
          `PLANES_NOT_COMPARED with a reason that says what checks it instead.`
      );
    if (!compared && exempt)
      for (const path of [exempt.evidence, exempt.alsoRequires])
        if (path && !existsSync(join(root, path)))
          problems.push(
            `STALE EXEMPTION: plane "${id}" is excused because it ${exempt.why}, on the ` +
              `evidence of ${path} — which does not exist. The exemption rests on that file ` +
              `being the other instrument; with it gone, node is simply uncompared.`
          );
  }

  for (const id of Object.keys(PLANES_NOT_COMPARED))
    if (!declared.has(id))
      problems.push(
        `STALE EXEMPTION: PLANES_NOT_COMPARED names "${id}", which rungs.json no longer ` +
          `declares. A hole held open for a plane that is gone reads as a considered decision.`
      );

  /*
   * A plane compared on one axis and not the other is half-checked, and the PASS line reports
   * both axes in one sentence. This is not hypothetical bookkeeping: DISPATCH is where the
   * SESSION is recorded, and #118's original defect was untagged, unsessioned django traces.
   */
  for (const id of Object.keys(PLANES))
    if (!(id in DISPATCH))
      problems.push(
        `TOTALITY: plane "${id}" is in PLANES but not DISPATCH, so its _common.py is compared ` +
          `while the dispatch that must record the session is not.`
      );
  for (const id of Object.keys(DISPATCH))
    if (!(id in PLANES))
      problems.push(
        `TOTALITY: plane "${id}" is in DISPATCH but not PLANES, so its dispatch is compared ` +
          `while the shared functions it calls are not.`
      );

  // ── functions within _common.py ───────────────────────────────────────────────────────────
  const defsByPlane = new Map();
  for (const [id, rel] of Object.entries(PLANES)) {
    const abs = join(root, rel);
    // A missing _common.py is already a hard failure in main(); saying nothing here avoids
    // reporting the same absence twice in different words.
    if (!existsSync(abs)) continue;
    defsByPlane.set(id, topLevelDefs(readFileSync(abs, "utf8")));
  }
  if (defsByPlane.size === 0)
    return [
      ...problems,
      "TOTALITY: no _common.py was readable on any plane, so the function census examined " +
        "nothing and 'SHARED covers them all' is true only of the empty set.",
    ];

  const union = new Set();
  for (const defs of defsByPlane.values()) for (const d of defs) union.add(d);
  if (union.size === 0)
    problems.push(
      "TOTALITY: ZERO top-level defs found in _common.py. Either the files are empty or the " +
        "def pattern stopped matching, and a census that finds nothing agrees with everything."
    );

  for (const name of union) {
    if (SHARED.includes(name) || name in FUNCTIONS_NOT_COMPARED) continue;
    problems.push(
      `TOTALITY: _common.py defines ${name}(), which SHARED does not name and no comparison ` +
        `opens. It is shared code on both planes that may differ between them without any ` +
        `gate noticing — the failure this file exists to catch, in the region it does not ` +
        `look at. Add it to SHARED, or to FUNCTIONS_NOT_COMPARED with a reason.`
    );
  }

  /*
   * A function present on ONE plane is divergence by itself, and the per-function comparison
   * cannot report it: it fails on the missing one, which reads as "a function is broken"
   * rather than "the planes no longer define the same set".
   */
  /*
   * ONE LINE PER PAIR, NOT ONE PER FUNCTION. An emptied plane makes every name one-sided, and
   * emitting 27 near-identical sentences buries the case this is actually for — a SINGLE
   * function added to one plane and forgotten on the other. Each pair is reported once, in a
   * fixed order, so the same tree always produces the same text.
   */
  const ids = [...defsByPlane.keys()].sort();
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      const only = (x, y) =>
        defsByPlane.get(x).filter((n) => !defsByPlane.get(y).includes(n));
      const aOnly = only(a, b);
      const bOnly = only(b, a);
      if (!aOnly.length && !bOnly.length) continue;
      const side = (who, names) =>
        names.length
          ? `${who} alone defines ${names.map((n) => `${n}()`).join(", ")}`
          : "";
      problems.push(
        `TOTALITY: ${a} and ${b} no longer define the same surface in _common.py — ` +
          [side(a, aOnly), side(b, bOnly)].filter(Boolean).join("; ") +
          `. That is divergence before any body is compared, and the per-function comparison ` +
          `cannot say it: it reports the absent side as a broken function instead.`
      );
    }

  return problems;
}

/*
 * THE CHECK RUNS WHEN THIS FILE IS THE ENTRY POINT, NOT WHEN IT IS IMPORTED.
 *
 * The selftest imports SHARED / SHARED_TOPOLOGY / SHARED_DECLARATION so its
 * fixture cannot fall behind the lists — see the note on TOPO_A there. Without
 * this guard that import also RAN the check against the selftest's own cwd, so
 * the moment the real tree went red the checker called process.exit(1) during
 * module evaluation and the selftest died before its first case. That is how it
 * behaved on the tree this change was written against.
 *
 * AN isMain GUARD IS ITSELF A WAY TO GO VACUOUS: if it ever answers false in CI
 * the script does nothing and exits 0, which is the check-shaped hole this file
 * spends thirty lines refusing elsewhere. What closes it is that the selftest
 * runs this file as a SUBPROCESS and several of its cases require a non-zero
 * exit and specific stderr. A guard that wrongly suppressed the run would make
 * every one of those cases fail, loudly, before the real check ever runs in CI.
 */
function main() {
  // The floor has to BE in the map. Everything below treats a rung's absence from
  // both planes as an ejected fork and passes; that is only safe because one rung
  // is required, and if REQUIRED_BACKEND stopped naming an entry here, every rung
  // would become optional and a tree with no backends at all would pass green.
  if (!(REQUIRED_BACKEND in BACKEND_PLANES)) {
    console.error(
      `REFUSING TO RUN: REQUIRED_BACKEND is "${REQUIRED_BACKEND}", which is not a ` +
        `key of BACKEND_PLANES (${Object.keys(BACKEND_PLANES).join(", ")}). ` +
        `Without a required rung every backend is optional and an empty tree passes.`
    );
    process.exit(2);
  }

  /*
   * TOTALITY FIRST, and refusing rather than guessing. If rungs.json cannot be read, the set of
   * planes that ought to be compared is unknown — every comparison below may still pass, and
   * what is unknown is whether they are all of them. Exit 2 says "not checked", which is the
   * one answer distinct from both "agrees" and "differs".
   */
  let totality;
  try {
    totality = checkSubjectTotality(process.cwd());
  } catch (err) {
    console.error(
      `REFUSING TO RUN: cannot read rungs.json, so the population of runtimes is unknown: ${err.message}`
    );
    console.error(
      "  Comparing the planes this file happens to name would produce a PASS line about the"
    );
    console.error(
      "  fleet from a census that never happened. Not checked is not the same as identical."
    );
    process.exit(2);
  }

  const failures = [...totality];

  /** The body of a top-level `def name(...)` including its docstring, up to the
   *  next top-level statement. Whitespace-normalised only at the edges.
   *
   *  ANCHORED AT COLUMN 0, AND THE `async ` PREFIX IS PART OF WHAT IS COMPARED (#527).
   *
   *  This was `src.indexOf("def " + name + "(")`. For `async def guarded_stream(`
   *  that indexOf finds the `def` INSIDE the keyword pair, so the extracted text
   *  began at `def` and the `async ` was silently excluded from both sides — one
   *  plane turning an async generator into a sync one would have compared EQUAL.
   *  Harmless while every SHARED entry was a plain `def`; a hole the moment one is
   *  not, which #527 adds. The unanchored form also matched an indented definition
   *  of the same name nested inside another function.
   *
   *  Measured before the fix: extracting `guarded_stream` from `async def
   *  guarded_stream(agen):` yielded text starting `def guarded_stream(agen):`. */
  function extractDef(src, name) {
    const m = new RegExp(`^(async )?def ${name}\\(`, "m").exec(src);
    if (m === null) return null;
    const start = m.index;
    const rest = src.slice(start);
    // The next line that begins at column 0 and is not a continuation ends it.
    const lines = rest.split("\n");
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.length && !/^\s/.test(l)) break;
      out.push(l);
    }
    return out.join("\n").trimEnd();
  }

  /**
   * A body with its DOCSTRING and full-line `#` comments removed.
   *
   * WHY THIS EXISTS, AND WHY IT IS THIS NARROW. `guarded_stream`'s docstring
   * legitimately differs between the planes: it names each framework's own class
   * — `StreamingResponse` on fastapi, `StreamingHttpResponse` on django — and
   * django's carries extra prose about #247 reaching that plane later. Measured,
   * that docstring is the ONLY difference between the two bodies. A byte compare
   * therefore goes RED on prose that is correct, and a check that fires on correct
   * input gets exempted within a week.
   *
   * WHAT IS DELIBERATELY NOT STRIPPED: every other string literal. The SSE frames
   * ARE literals — `yield f'data: {"type":"text-end",...}'` — so normalising
   * strings in general would erase exactly the divergence this check exists to
   * catch. Only the leading docstring and lines whose first non-space character is
   * `#` are dropped; a `#` inside a string is left alone because it is not matched
   * at line start.
   *
   * THE COST, STATED RATHER THAN HIDDEN: the thirteen functions compared before
   * #527 were byte-identical INCLUDING their comments, and this relaxes them to
   * code-identical. A future comment-only divergence in those is no longer caught.
   * That is a real reduction, accepted because the alternative is a check nobody
   * can keep green. The selftest pins that a CODE divergence in an original
   * function still fails.
   */
  const TRIPLE = ['"'.repeat(3), "'".repeat(3)];

  function stripDocsAndComments(body) {
    const lines = body.split("\n");
    const out = [lines[0]]; // the `def` line itself
    let i = 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    const line = lines[i] ?? "";
    const q = TRIPLE.find((t) => line.trim().startsWith(t));
    if (q) {
      const after = line.trim().slice(3);
      if (!(after.length >= 3 && after.endsWith(q))) {
        i++;
        while (i < lines.length && !lines[i].includes(q)) i++;
      }
      i++;
    }
    for (; i < lines.length; i++) {
      if (/^\s*#/.test(lines[i])) continue;
      out.push(lines[i]);
    }
    return out.join("\n").trimEnd();
  }

  /** The value of a module-level `NAME = ...`, as written, with balanced brackets.
   *
   *  READS TO THE CLOSING BRACKET RATHER THAN THE END OF THE LINE. Every
   *  GATED_TOPOLOGIES in the tree is a one-liner today, and a line-based reader
   *  would work on all six — right up until someone wraps a long frozenset across
   *  two lines, at which point it silently compares the first line of each and
   *  calls two different sets equal. That is a check whose subject shrinks without
   *  its verdict changing, so it is closed here rather than left to a future
   *  formatter.
   *
   *  Returns null if the constant is absent; the caller decides what absence means.
   */
  function extractConst(src, name) {
    const lines = src.split("\n");
    const start = lines.findIndex((l) => new RegExp(`^${name}\\s*=`).test(l));
    if (start === -1) return null;

    const opens = { "(": ")", "[": "]", "{": "}" };
    const stack = [];
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      out.push(line);
      // Comments and string contents cannot open a bracket that matters here;
      // strip a trailing `#` comment so `frozenset()  # empty (see note)` closes.
      const code = line.replace(/#.*$/, "");
      for (const ch of code) {
        if (opens[ch]) stack.push(opens[ch]);
        else if (ch === stack[stack.length - 1]) stack.pop();
      }
      if (stack.length === 0) break;
    }
    return out
      .join("\n")
      .replace(new RegExp(`^${name}\\s*=\\s*`), "")
      .trim();
  }

  const sources = {};
  for (const [plane, path] of Object.entries(PLANES)) {
    if (!existsSync(path)) {
      console.error(`FAIL: ${plane}'s _common.py is missing at ${path}.`);
      console.error(
        "A comparison with an absent side is not a passing comparison."
      );
      process.exit(2);
    }
    sources[plane] = readFileSync(path, "utf8");
  }

  let compared = 0;
  for (const fn of SHARED) {
    const bodies = {};
    for (const [plane, src] of Object.entries(sources)) {
      const body = extractDef(src, fn);
      if (body === null) {
        failures.push(
          `${plane} does not define ${fn}(). Every trace from that runtime is ` +
            `missing whatever it records — untagged, unsessioned, and invisible ` +
            `to the filters the other plane's traces answer.`
        );
        continue;
      }
      bodies[plane] = body;
    }
    if (Object.keys(bodies).length < 2) continue;
    compared++;
    const [[aName, a], [bName, b]] = Object.entries(bodies);
    if (stripDocsAndComments(a) !== stripDocsAndComments(b)) {
      failures.push(
        `${fn}() DIFFERS between ${aName} and ${bName}. Two implementations that ` +
          `both exist and disagree is the shape that produced #232 and #247/#302 — ` +
          `found only because someone compared.`
      );
    }
  }

  /*
   * WHAT WAS COMPARED, NOT WHAT WAS LISTED. `SHARED.length` is the size of a literal in this
   * file and says nothing about the tree in front of it; printing it as the count of functions
   * checked would be a number the run never computed — this file's own subject.
   */
  const sharedCompared = compared;

  // The per-rung backends: the gated-topology builder AND the declaration it reads.
  //
  // PRESENCE IS MEASURED, NOT ASSUMED. Both sides absent means the rung was ejected
  // and there is genuinely nothing to compare. ONE side absent is a defect and is
  // never a skip — a half-present rung is precisely the asymmetry this file exists
  // to find, and treating it as "nothing to compare" would let it pass.
  const backendsExamined = [];
  const backendsAbsent = [];

  for (const [rung, planes] of Object.entries(BACKEND_PLANES)) {
    const present = Object.entries(planes).filter(([, path]) =>
      existsSync(path)
    );

    if (present.length === 0) {
      if (rung === REQUIRED_BACKEND) {
        console.error(`FAIL: ${rung} is missing on BOTH planes.`);
        console.error(
          `${rung} is rung 1 and survives every eject, so its absence is a broken ` +
            `tree rather than a fork. A comparison with no sides is not a passing one.`
        );
        process.exit(2);
      }
      backendsAbsent.push(rung);
      continue;
    }

    // HALF-PRESENT IS A HARD REFUSAL, NOT A FINDING. An eject drops a rung from
    // BOTH planes; one plane alone means the runtimes no longer offer the same
    // frameworks, and every comparison below it would be reporting on a tree
    // whose shape already answers the question. Exit 2 rather than 1 keeps it
    // distinguishable from a divergence the source can describe.
    if (present.length < Object.keys(planes).length) {
      for (const [plane, path] of Object.entries(planes)) {
        if (!existsSync(path)) {
          console.error(
            `FAIL: ${plane}'s ${rung} backend is missing at ${path}.`
          );
        }
      }
      console.error(
        "A comparison with an absent side is not a passing comparison, and this " +
          "is not an eject: an eject removes the rung from both planes at once."
      );
      process.exit(2);
    }

    backendsExamined.push(rung);
    const src = Object.fromEntries(
      present.map(([plane, path]) => [plane, readFileSync(path, "utf8")])
    );

    for (const fn of SHARED_TOPOLOGY) {
      const bodies = {};
      for (const [plane, text] of Object.entries(src)) {
        const body = extractDef(text, fn);
        if (body === null) {
          failures.push(
            `${plane}'s ${rung} backend does not define ${fn}(). #449's ruling ` +
              `assumes both planes decide gating the same way; a plane that does ` +
              `not define this at all is not covered by the behavioural test that ` +
              `stands in for it.`
          );
          continue;
        }
        bodies[plane] = body;
      }
      if (Object.keys(bodies).length < 2) continue;
      compared++;
      const [[aName, a], [bName, b]] = Object.entries(bodies);
      if (a !== b) {
        failures.push(
          `${rung}'s ${fn}() DIFFERS between ${aName} and ${bName}. It decides ` +
            `whether a gated graph is built, and #449 rests on an upstream-gated ` +
            `call emitting no tool frames — asserted behaviourally against fastapi ` +
            `only. Divergence here means that assertion no longer describes ${bName}.`
        );
      }
    }

    // The declaration, which the reader above only READS. This is the comparison
    // that was missing: see the note on BACKEND_PLANES for the tree that shipped
    // divergent gating under a green run of this script.
    for (const name of SHARED_DECLARATION) {
      const values = {};
      for (const [plane, text] of Object.entries(src)) {
        const value = extractConst(text, name);
        if (value === null) {
          failures.push(
            `${plane}'s ${rung} backend does not declare ${name}. The dispatch reads ` +
              `it to decide whether to demand an approval policy and ${SHARED_TOPOLOGY[0]}() ` +
              `reads it to decide whether to build a gated graph; a plane without it ` +
              `cannot answer either question, and the absence is not a smaller version ` +
              `of an empty set.`
          );
          continue;
        }
        values[plane] = value;
      }
      if (Object.keys(values).length < 2) continue;
      compared++;
      const [[aName, a], [bName, b]] = Object.entries(values);
      if (a !== b) {
        failures.push(
          `${rung}'s ${name} DIFFERS: ${aName} declares ${a}, ${bName} declares ${b}. ` +
            `The two planes gate DIFFERENT TOPOLOGIES. ${SHARED_TOPOLOGY[0]}() can be ` +
            `byte-identical while this differs — it reads this constant rather than ` +
            `containing it — so an identical builder is not evidence the planes agree.`
        );
      }
    }
  }

  // Both dispatches must actually record a session, or the parity above is a
  // parity of two things nobody calls.
  for (const [plane, path] of Object.entries(DISPATCH)) {
    if (!existsSync(path)) {
      console.error(`FAIL: ${plane}'s dispatch is missing at ${path}.`);
      process.exit(2);
    }
    const src = readFileSync(path, "utf8");
    const call = src.match(/set_run_axes\(([\s\S]{0,400}?)\)/);
    if (!call) {
      failures.push(
        `${plane}'s dispatch (${path}) never calls set_run_axes(). The functions ` +
          `can be identical and still record nothing.`
      );
      continue;
    }
    compared++;
    if (!/session\s*=/.test(call[1])) {
      failures.push(
        `${plane}'s set_run_axes() call omits session=. #171: without it a ` +
          `conversation's turns arrive as unrelated traces, which is what the ` +
          `whole client/route/backend chain was fixed to prevent.`
      );
    }
  }

  if (compared === 0) {
    console.error("REFUSING TO PASS: compared 0 functions and 0 dispatches.");
    console.error(
      "A check with no subject is vacuous, and its green reads as coverage."
    );
    process.exit(2);
  }

  // The same refusal one level down. `compared` can be non-zero on _common.py and
  // the dispatches alone, so it does not witness that any BACKEND was opened, and
  // the backend half is the half #332 turns on.
  //
  // UNREACHABLE TODAY, AND SAID SO RATHER THAN DRESSED UP. While REQUIRED_BACKEND
  // is a key of BACKEND_PLANES, langchain absent from both planes already exits 2
  // above, so this cannot fire and the selftest has no case for it — there is no
  // tree a fixture can write that reaches it. What it actually defends is the map
  // losing its required entry, which is why the assertion below states that
  // invariant directly instead of leaving this to imply it. A guard whose only
  // description of itself is a reachable-sounding comment is the shape this whole
  // change exists to remove.
  if (backendsExamined.length === 0) {
    console.error("REFUSING TO PASS: opened 0 rung backends.");
    console.error(
      `Every entry in BACKEND_PLANES was absent or half-present, so neither ` +
        `${SHARED_TOPOLOGY.join(", ")} nor ${SHARED_DECLARATION.join(
          ", "
        )} was ` +
        `compared on any rung. The _common.py comparisons above passed and say ` +
        `nothing about gating.`
    );
    process.exit(2);
  }

  if (failures.length) {
    console.error("FAIL — the two runtimes do not record runs identically:\n");
    for (const f of failures) console.error("  " + f + "\n");
    process.exit(1);
  }

  // THE SUCCESS LINE NAMES WHAT IT OPENED, because the previous one did not and
  // that is why this file needed fixing. It read "including the gated-topology
  // builder" while comparing a builder whose declaration it never opened, so an
  // auditor was told the gating was covered by the run that could not see it. A
  // green that does not say what it examined can only be trusted by someone who
  // has read the source, and they are not the person it is written for.
  const examined =
    backendsExamined.length === Object.keys(BACKEND_PLANES).length
      ? `all ${backendsExamined.length} rung backends (${backendsExamined.join(
          ", "
        )})`
      : `${backendsExamined.length} of ${
          Object.keys(BACKEND_PLANES).length
        } rung ` +
        `backends (${backendsExamined.join(", ")}; ${backendsAbsent.join(
          ", "
        )} ` +
        `absent from both planes, which is an ejected fork rather than a gap)`;

  /*
   * "both runtimes" was accurate about the two it opened and silent about how many there are.
   * Now the sentence carries its own denominator, so a third plane arriving makes the PASS
   * line visibly narrower instead of leaving it to mean whatever the reader assumes.
   */
  const declaredCount = declaredPlanes(process.cwd()).size;
  const skipped = Object.keys(PLANES_NOT_COMPARED);
  const planeScope =
    `${Object.keys(PLANES).length} of ${declaredCount} declared runtimes` +
    (skipped.length
      ? ` (${skipped.join(", ")} compared by another instrument, see the note)`
      : "");

  console.log(
    `PASS: ${sharedCompared} shared functions in _common.py — which the totality guard ` +
      `confirmed this run is every top-level def either plane defines — are identical across ` +
      `${planeScope} once docstrings and comments are set aside; ` +
      `${SHARED_TOPOLOGY.join(", ")} and the ${SHARED_DECLARATION.join(
        ", "
      )} ` +
      `declaration it reads agree across both planes for ${examined}; ` +
      `and both dispatches record a session (${compared} comparisons).`
  );
}

// `realpath` on both sides: a symlinked scripts/ directory (a worktree, a
// packed CI checkout) makes the raw strings differ for the same file, and the
// guard would then silently suppress the run.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const invokedAs = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedAs === realpathSync(fileURLToPath(import.meta.url))) main();
