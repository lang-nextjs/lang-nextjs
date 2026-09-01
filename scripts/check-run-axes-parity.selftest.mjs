#!/usr/bin/env node
/**
 * Proves scripts/check-run-axes-parity.mjs can FAIL — do not remove.
 *
 * The checker's whole value is that it notices a divergence nobody looked for.
 * A selftest that only fed it matching planes would confirm the happy path and
 * establish nothing about the case it exists for — which is the defect class
 * this repo tracks, one level up.
 *
 * Each case builds a throwaway tree with the same layout the checker expects
 * and runs it there, so the cases are exact rather than dependent on whatever
 * the real backends happen to contain today.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const CHECKER = join(process.cwd(), "scripts", "check-run-axes-parity.mjs");

/*
 * THE FIXTURE IS DERIVED FROM THE CHECKER'S OWN LIST, not a copy of it (#375).
 *
 * FN_A used to hardcode the two functions SHARED contained. Adding a third made this
 * file's MATCHED case fail -- a fixture whose 'two identical planes' were no longer
 * identical to what the checker asks for, so the case reported the checker broken when
 * the fixture was. It expired the moment the list grew, which is the premise-goes-stale
 * shape #375 exists for, and the repair is the same: derive the scenario from the thing
 * it is about.
 *
 * The two named below keep real bodies because other cases reference them by name;
 * anything else SHARED gains gets a stub, so a new entry cannot leave this incomplete.
 */
import {
  SHARED,
  SHARED_TOPOLOGY,
  SHARED_DECLARATION,
} from "./check-run-axes-parity.mjs";

const FN_A =
  `def set_run_axes(**axes) -> None:
    """doc."""
    _RUN_AXES.set({k: v for k, v in axes.items() if v})


def langfuse_trace_metadata() -> dict:
    """doc."""
    axes = dict(_RUN_AXES.get())
    session = axes.pop("session", None)
    md: dict = {"langfuse_tags": [f"{k}:{v}" for k, v in sorted(axes.items())]}
    if session:
        md["langfuse_session_id"] = session
    return md
` +
  SHARED.filter((n) => n !== "set_run_axes" && n !== "langfuse_trace_metadata")
    .map((n) =>
      [``, ``, `def ${n}(*args, **kwargs):`, `    return None`, ``].join("\n")
    )
    .join("");

/*
 * THE SECOND FILE PAIR (#449). Built from SHARED_TOPOLOGY the same way FN_A is
 * built from SHARED — so a future addition to either list cannot leave this
 * fixture writing a tree the checker has since outgrown.
 *
 * THAT IS THE DEFECT THIS CONSTANT EXISTS BECAUSE OF. The checker gained a
 * second pair and the fixture kept writing only the first, so every case ran
 * against a tree that could not contain the new subject — and the suite went red
 * for a missing file rather than green over a hole, which was luck. A fixture
 * can share the blind spot of the thing it tests, and the shape to watch for is
 * a case count that does not move when the subject grows. It went 6 to 9 when the
 * second file pair landed, and 12 to 19 when #592 added the declaration and the
 * per-rung discovery — a subject growing by two dimensions at once.
 */
const TOPO_A =
  `async def stream_chat_react(messages):
    """doc."""
    gated = "react" in GATED_TOPOLOGIES
    graph = get_gated_executor() if gated else get_executor()
    async for frame in _stream_agent_events(graph, {"messages": messages}):
        yield frame
` +
  SHARED_TOPOLOGY.filter((n) => n !== "stream_chat_react")
    .map((n) =>
      [``, ``, `def ${n}(*args, **kwargs):`, `    return None`, ``].join("\n")
    )
    .join("");

/*
 * #527 — THE CALIBRATION IS TWO-SIDED, AND ONE SIDE ALONE IS WORTHLESS.
 *
 * `guarded_stream` emits the SSE frames and its docstring LEGITIMATELY differs
 * between the planes — it names each framework's own response class. So the
 * comparison strips docstrings and full-line comments, and that creates a
 * two-sided risk rather than one:
 *
 *   strip too little  -> red on correct prose, exempted within a week
 *   strip too much    -> green on a real behavioural divergence
 *
 * A suite testing only one direction cannot tell a calibrated normaliser from a
 * broken one. These three cases pin both edges and the async prefix between them.
 */
const GUARDED_REAL = `async def guarded_stream(agen):
    """Yield an agent stream, turning a mid-stream failure into a real message.

    The proxy was not wrong. StreamingResponse has already flushed 200.
    """
    async for frame in agen:
        yield frame
    yield 'data: {"type":"text-end","id":"t1"}\\n\\n'
`;

/*
 * THE DECLARATION, WHICH THE BUILDER ABOVE ONLY READS (#332, #592).
 *
 * TOPO_A contains `"react" in GATED_TOPOLOGIES` and does not contain
 * GATED_TOPOLOGIES. That is not an oversight in the fixture — it is the shape of
 * the defect. On the real tree the builder was byte-identical on both planes
 * while this constant differed, and the checker compared only the builder and
 * passed. So the fixture has to be able to write the two independently, or no
 * case here can express the tree that shipped.
 *
 * Built from SHARED_DECLARATION for the reason TOPO_A is built from
 * SHARED_TOPOLOGY: a list that grows must not leave this writing a tree the
 * checker has outgrown.
 */
const decls = (value) =>
  // null means WRITE NO DECLARATION, which is a different tree from one that
  // declares an empty set. The checker has to tell those apart — an absent
  // declaration cannot answer "is this topology gated" at all, while
  // `frozenset()` answers "no" — so the fixture has to be able to write both.
  value === null
    ? ""
    : SHARED_DECLARATION.map((n) => `\n\n${n} = ${value}\n`).join("");

const GATED_REACT = 'frozenset({"react"})';

const withGuarded = (base, body) =>
  base.replace(
    "\n\ndef guarded_stream(*args, **kwargs):\n    return None\n",
    "\n\n" + body
  );

const DISPATCH_OK = `def view(body):
    _common.set_run_axes(
        runtime="x",
        framework=body["f"],
        topology=body["t"],
        session=body.get("sessionId"),
    )
`;

/*
 * THE FIXTURE WRITES EVERY RUNG, AND WRITES THE DECLARATION SEPARATELY.
 *
 * `rungs` is which rungs exist on BOTH planes — the ladder. `halfPresent` writes
 * a rung to one plane only, which is the tree an interrupted eject leaves and
 * which the checker refuses outright. Omitting a rung from `rungs` is the
 * ordinary ejected fork and must PASS.
 */
const ALL_RUNGS = ["langchain", "langgraph", "deepagents"];

const backendPath = {
  fastapi: (rung) => `apps/fastapi-backend/ai_backends/${rung}.py`,
  django: (rung) =>
    `apps/django-backend/deepagents_backend/ai_backends/${rung}.py`,
};

function tree({
  fastapi = FN_A,
  django = FN_A,
  fTopo = TOPO_A,
  dTopo = TOPO_A,
  fDecl = GATED_REACT,
  dDecl = GATED_REACT,
  rungs = ALL_RUNGS,
  halfPresent = null,
  fDisp = DISPATCH_OK,
  dDisp = DISPATCH_OK,
  drop = null,
}) {
  const root = mkdtempSync(join(tmpdir(), "axes-parity-"));
  const write = (rel, text) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  if (drop !== "fastapi-common")
    write("apps/fastapi-backend/ai_backends/_common.py", fastapi);
  if (drop !== "django-common")
    write(
      "apps/django-backend/deepagents_backend/ai_backends/_common.py",
      django
    );

  // The backends. Every rung gets the same builder and declaration unless the
  // case overrides them — the overrides land on langchain, because that is the
  // rung the real divergence happened on and the one present in every fork.
  for (const rung of rungs) {
    if (drop !== "fastapi-topo")
      write(backendPath.fastapi(rung), fTopo + decls(fDecl));
    if (drop !== "django-topo")
      write(backendPath.django(rung), dTopo + decls(dDecl));
  }
  if (halfPresent)
    write(
      backendPath[halfPresent.plane](halfPresent.rung),
      TOPO_A + decls(GATED_REACT)
    );

  write("apps/fastapi-backend/main.py", fDisp);
  write("apps/django-backend/deepagents_backend/views.py", dDisp);
  return root;
}

function run(root) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER], { cwd: root, encoding: "utf8" }),
    };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const cases = [
  {
    name: "WIRE REAL   an emitted frame's value differs -> must be RED (#527)",
    tree: () =>
      tree({
        fastapi: withGuarded(FN_A, GUARDED_REAL),
        django: withGuarded(
          FN_A,
          GUARDED_REAL.replace('"type":"text-end"', '"type":"text-ended"')
        ),
      }),
    expect: (r) => r.code === 1 && /guarded_stream\(\) DIFFERS/.test(r.out),
  },
  {
    name: "WIRE PROSE  only the docstring differs -> must be GREEN (#527)",
    tree: () =>
      tree({
        fastapi: withGuarded(FN_A, GUARDED_REAL),
        django: withGuarded(
          FN_A,
          GUARDED_REAL.replace(
            "StreamingResponse has already flushed 200.",
            "StreamingHttpResponse has already flushed 200, and #247 reached this plane later."
          )
        ),
      }),
    expect: (r) => r.code === 0 && /PASS:/.test(r.out),
  },
  {
    name: "WIRE ASYNC  async def -> def on one plane -> must be RED (#527)",
    tree: () =>
      tree({
        fastapi: withGuarded(FN_A, GUARDED_REAL),
        django: withGuarded(
          FN_A,
          GUARDED_REAL.replace("async def guarded_stream", "def guarded_stream")
        ),
      }),
    // Before #527 anchored extractDef, indexOf found the `def` INSIDE
    // `async def` and this compared EQUAL.
    expect: (r) => r.code === 1 && /guarded_stream\(\) DIFFERS/.test(r.out),
  },
  {
    name: "DIVERGED   the two implementations differ",
    tree: () =>
      tree({ django: FN_A.replace('axes.pop("session", None)', "None") }),
    expect: (r) =>
      r.code === 1 && /langfuse_trace_metadata\(\) DIFFERS/.test(r.out),
  },
  {
    name: "MISSING-FN one plane never defines it (the real django state)",
    tree: () => tree({ django: "def something_else():\n    pass\n" }),
    expect: (r) => r.code === 1 && /does not define set_run_axes/.test(r.out),
  },
  {
    name: "NO-SESSION a dispatch records axes but omits session=",
    tree: () => tree({ dDisp: DISPATCH_OK.replace(/\n\s*session=.*,/, "") }),
    expect: (r) => r.code === 1 && /omits session=/.test(r.out),
  },
  {
    name: "NO-CALL    a dispatch never calls set_run_axes at all",
    tree: () => tree({ dDisp: "def view(body):\n    return 1\n" }),
    expect: (r) => r.code === 1 && /never calls set_run_axes/.test(r.out),
  },
  {
    name: "ABSENT     a missing source file REFUSES, does not pass",
    tree: () => tree({ drop: "django-common" }),
    expect: (r) => r.code === 2 && /is missing at/.test(r.out),
  },
  /*
   * THE NEW PAIR NEEDS ITS OWN THREE, and the divergence case is the one that
   * matters: if the fixture only ever wrote identical content for both planes,
   * the new parity arm would pass BY SYMMETRY — equal in every input it had ever
   * been given — and would be indistinguishable from an arm that compares
   * nothing.
   */
  {
    name: "TOPO-DIFF  the gated-topology builders differ between planes",
    tree: () =>
      tree({ dTopo: TOPO_A.replace('"react" in GATED_TOPOLOGIES', "True") }),
    expect: (r) => r.code === 1 && /stream_chat_react\(\) DIFFERS/.test(r.out),
  },
  {
    name: "TOPO-MISS  one plane never defines the gated-topology builder",
    tree: () => tree({ dTopo: "def unrelated():\n    pass\n" }),
    expect: (r) =>
      r.code === 1 && /does not define stream_chat_react/.test(r.out),
  },
  {
    name: "TOPO-GONE  a missing second-pair source REFUSES, does not pass",
    tree: () => tree({ drop: "django-topo" }),
    expect: (r) =>
      r.code === 2 && /langchain backend is missing at/.test(r.out),
  },
  /*
   * #592 — THE DECLARATION CASES. Everything above this point passed on the tree
   * that shipped divergent gating, which is the whole reason these exist.
   */
  {
    name: "DECL-DIFF  identical builders, different declarations -> RED",
    // THE TREE THAT SHIPPED. fastapi armed react, django did not, both
    // stream_chat_react bodies byte-identical, and the checker exited 0.
    tree: () => tree({ dDecl: "frozenset()" }),
    expect: (r) =>
      r.code === 1 &&
      /GATED_TOPOLOGIES DIFFERS/.test(r.out) &&
      // The values must appear. "They differ" without saying how sends the
      // reader back to the source to find out what the check already knew.
      /frozenset\(\{"react"\}\)/.test(r.out) &&
      /frozenset\(\)/.test(r.out),
  },
  {
    name: "DECL-SAME  identical declarations -> GREEN (the companion)",
    // Without this the case above is satisfied by a checker that reds on every
    // tree. An absence assertion needs a presence companion.
    tree: () => tree({ fDecl: "frozenset()", dDecl: "frozenset()" }),
    expect: (r) => r.code === 0 && /PASS:/.test(r.out),
  },
  {
    name: "DECL-MISS  one plane never declares it -> RED",
    tree: () => tree({ dTopo: TOPO_A, dDecl: null, rungs: ALL_RUNGS }),
    expect: (r) =>
      r.code === 1 && /does not declare GATED_TOPOLOGIES/.test(r.out),
  },
  {
    name: "DECL-MULTI a difference on the SECOND line of a wrapped set -> RED",
    // Proves extractConst reads to the closing bracket rather than the end of
    // the line. A line-based reader passes this case while comparing two
    // different sets, and every declaration in the tree is a one-liner today —
    // so nothing else here would ever catch the regression.
    tree: () =>
      tree({
        fDecl:
          'frozenset(\n    {\n        "react",\n        "plan-execute",\n    }\n)',
        dDecl:
          'frozenset(\n    {\n        "react",\n        "deep-research",\n    }\n)',
      }),
    expect: (r) =>
      r.code === 1 &&
      /GATED_TOPOLOGIES DIFFERS/.test(r.out) &&
      /plan-execute/.test(r.out),
  },
  {
    name: "RUNG-GONE  a rung absent from BOTH planes -> GREEN, and SAYS SO",
    // An ejected fork. The pass is correct; the requirement is that it is not
    // silent, because a skip nobody can see is the thing it replaced.
    tree: () => tree({ rungs: ["langchain"] }),
    expect: (r) =>
      r.code === 0 &&
      /1 of 3 rung backends/.test(r.out) &&
      /langgraph, deepagents absent/.test(r.out),
  },
  {
    name: "RUNG-HALF  a rung on ONE plane only -> REFUSES (exit 2)",
    tree: () =>
      tree({
        rungs: ["langchain"],
        halfPresent: { plane: "fastapi", rung: "langgraph" },
      }),
    expect: (r) =>
      r.code === 2 &&
      /django's langgraph backend is missing at/.test(r.out) &&
      /this is not an eject/.test(r.out),
  },
  {
    name: "RUNG-NONE  no rung backend at all -> REFUSES, does not pass",
    // langchain is rung 1: absent from both planes is a broken tree, not a fork.
    tree: () => tree({ rungs: [] }),
    expect: (r) =>
      r.code === 2 && /langchain is missing on BOTH planes/.test(r.out),
  },
  {
    name: "MATCHED    identical planes with sessions pass",
    tree: () => tree({}),
    // Matches the PASS line, whose wording changed in #527 when the
    // comparison stopped being byte-exact over docstrings.
    expect: (r) => r.code === 0 && /identical across both runtimes/.test(r.out),
  },
];

let pass = 0;
for (const c of cases) {
  const root = c.tree();
  const r = run(root);
  const ok = c.expect(r);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${c.name}`);
  if (!ok)
    console.log(
      `        exit=${r.code}\n        ${r.out
        .trim()
        .split("\n")
        .join("\n        ")}`
    );
  if (ok) pass++;
  rmSync(root, { recursive: true, force: true });
}

console.log(
  `\n${pass === cases.length ? "PASS" : "FAIL"}: ${pass}/${
    cases.length
  }. The checker refuses a divergence, a missing\n` +
    `      implementation, a dispatch that records no session, a dispatch that records\n` +
    `      nothing, and an absent source file — across _common.py and every rung\n` +
    `      backend present. It refuses a DECLARATION that differs while its reader is\n` +
    `      byte-identical (#592), which is the tree main shipped, and it refuses a rung\n` +
    `      that exists on one plane only. A rung absent from both is an ejected fork:\n` +
    `      that passes, and the pass names what it skipped.`
);
process.exit(pass === cases.length ? 0 : 1);
