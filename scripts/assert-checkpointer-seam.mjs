#!/usr/bin/env node
/**
 * Every gating rung resolves its checkpointer through the shared seam (#643).
 *
 * WHY THIS EXISTS AS A GATE RATHER THAN A CONVENTION. The fix replaced ONE silent
 * constant with SIX call sites — three rungs x two planes — and six
 * independently-editable declarations is the shape that drifts. The failure is
 * silent in the direction that matters: a rung that quietly builds its own
 * `InMemorySaver()` keeps working, keeps passing every approval test, and simply
 * stops honouring an injected saver. Nobody would notice until a deployment
 * supplied one and one rung ignored it.
 *
 * TWO PROPERTIES, AND THE SECOND IS THE ONE PEOPLE WILL GET WRONG.
 *
 *   1. no gating backend constructs a checkpointer itself
 *   2. each passes `approval_saver(__name__)` — its OWN scope, not a literal
 *
 * (2) matters because `derive_thread_id` returns `approval:<sessionId>` with no
 * rung in it. Two rungs resolving the same scope string share a saver and
 * therefore share a thread for the same session — measured on this repo: with one
 * saver a second rung read 2 messages written by the first under the same id;
 * with separate savers it read 0. A hardcoded scope is how that happens by
 * accident, and `__name__` is the one spelling that cannot collide.
 *
 * IT NAMES THE OFFENDER. "the six disagree" sends a reader to compare six files;
 * this says which file, which line, and which property.
 *
 * MODULES ARE DISCOVERED, NOT LISTED. This file survives every eject and the rung
 * backends do not, so a hardcoded path list would be green on the ladder and fail
 * on a missing file in a fork (#588/#590). A plane absent from the tree is not a
 * finding; a plane present with a divergent backend is.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { extractConst } from "./lib/python-const.mjs";

const ROOT = process.cwd();

const PLANES = {
  fastapi: "apps/fastapi-backend/ai_backends",
  django: "apps/django-backend/deepagents_backend/ai_backends",
};

const SEAM_CALL = "approval_saver(__name__)";
const problems = [];
let examined = 0;
const gating = [];

for (const [plane, dir] of Object.entries(PLANES)) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue; // an ejected fork legitimately lacks a plane

  for (const file of readdirSync(abs).filter((f) => f.endsWith(".py"))) {
    if (file === "_common.py" || file === "__init__.py") continue;
    const rel = `${dir}/${file}`;
    const src = readFileSync(join(abs, file), "utf-8");

    const declared = extractConst(src, "GATED_TOPOLOGIES");
    if (declared === null) continue; // not a dispatchable backend
    // An UNGATED rung builds no gated graph, so it has no checkpointer to get
    // wrong. Saying so beats silently skipping it.
    if (/frozenset\(\s*\)/.test(declared)) continue;

    examined++;
    gating.push(rel);

    if (/InMemorySaver\s*\(/.test(src)) {
      problems.push(
        `${rel} constructs a checkpointer directly. It will ignore an injected ` +
          `saver while every approval test still passes — supply it through ` +
          `${SEAM_CALL} instead.`
      );
    }

    const lines = src.split("\n");
    const at = lines.findIndex((l) => /checkpointer\s*=/.test(l));
    if (at === -1) {
      problems.push(
        `${rel} gates ${declared} but passes no checkpointer. interrupt() ` +
          `requires one — upstream: "To use an interrupt, you must enable a ` +
          `checkpointer, as the feature relies on persisting the graph state."`
      );
    } else if (!lines[at].includes(SEAM_CALL)) {
      problems.push(
        `${rel}:${at + 1} passes \`${lines[at].trim()}\` rather than ` +
          `\`checkpointer=${SEAM_CALL}\`. A literal scope makes two rungs share ` +
          `one saver, and derive_thread_id puts no rung in the thread id — so a ` +
          `decision for one rung's thread can resume another's graph.`
      );
    }
  }
}

/*
 * NOTHING EXAMINED IS NOT NOTHING WRONG. A tree with no gating backend is a
 * legitimate fork; a tree WITH them where none was read is a check that lost its
 * subject, and its green would read as coverage.
 */
if (examined === 0) {
  const anyPlane = Object.values(PLANES).some((d) => existsSync(join(ROOT, d)));
  if (anyPlane) {
    console.error(
      "REFUSING TO PASS: a backend plane is present and NO gating rung was " +
        "examined. Either every rung is ungated — in which case #332 was " +
        "reverted — or this check stopped finding its subject."
    );
    process.exit(2);
  }
  console.log("PASS: no backend plane in this tree — nothing to check.");
  process.exit(0);
}

if (problems.length) {
  console.error(
    `FAIL: ${problems.length} gating backend(s) do not resolve the checkpointer ` +
      `through the shared seam:\n`
  );
  for (const p of problems) console.error("  " + p + "\n");
  process.exit(1);
}

console.log(
  `PASS: all ${examined} gating backend(s) resolve the checkpointer through ` +
    `${SEAM_CALL} and none builds its own — ${gating.join(", ")}.`
);

/*
 * WHAT A GREEN HERE DOES NOT MEAN, printed because the gap between "the
 * checkpointer seam is guarded" and "approval resumption is guarded" is one
 * sentence wide and this check only covers the first.
 *
 * The pattern is check-doc-claims': a gate that lists its exclusions can be
 * audited in one read, and one that does not can only be trusted by someone who
 * has read its source. This repo has already had a green from a checker that
 * excluded the subject offered as evidence about the subject.
 */
console.log(
  "\nNOT CHECKED (so a pass is not read as 'approvals resume correctly'):\n" +
    "  - that a checkpointer is DURABLE. The shipped default is in-memory, so a\n" +
    "    restart or a second worker loses pending approvals. #643 made the saver a\n" +
    "    parameter; choosing a durable one is a deployment decision nobody has made.\n" +
    "  - rung 4, which gates at the SSE layer via createApprovalGatingTransform and\n" +
    "    holds its pending state in the transform. It uses no checkpointer at all, so\n" +
    "    it is outside this check's subject entirely — a second approval mechanism\n" +
    "    with its own failure mode, guarded elsewhere or not at all.\n" +
    "  - that a decision, once submitted, is HONOURED. This is configuration-level.\n" +
    "    Measured THROUGH THE ROUTE with no checkpointer at all: the first request\n" +
    "    answers 200, withholds the tool, and emits NO approval frame — the reader\n" +
    "    asks graph state for pending interrupts and a stateless graph has none. A\n" +
    "    decision that does arrive is then refused 409, so the route fails closed.\n" +
    "    The cost is not an unapproved execution; it is a turn that withholds and\n" +
    "    reports nothing, which is the defect #413 held the gate disarmed to avoid.\n" +
    "    Every assertion of the form `effects == 0` passes in that world, so the\n" +
    "    negative cannot separate a working gate from a silent one.\n" +
    "\n" +
    "    An earlier version of this note said the payload is still emitted. That is\n" +
    "    true of the bare create_agent + HumanInTheLoopMiddleware and false of the\n" +
    "    route, which is the middleware-to-route hop that has misled three people on\n" +
    "    this issue. Measured on both surfaces before this sentence was rewritten."
);
