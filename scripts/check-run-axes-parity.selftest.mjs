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
import { SHARED, SHARED_TOPOLOGY } from "./check-run-axes-parity.mjs";

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
 * a case count that does not move when the subject grows. This one goes 6 to 9.
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

const DISPATCH_OK = `def view(body):
    _common.set_run_axes(
        runtime="x",
        framework=body["f"],
        topology=body["t"],
        session=body.get("sessionId"),
    )
`;

function tree({
  fastapi = FN_A,
  django = FN_A,
  fTopo = TOPO_A,
  dTopo = TOPO_A,
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
  // The second pair, written for every case — the checker reads it unconditionally.
  if (drop !== "fastapi-topo")
    write("apps/fastapi-backend/ai_backends/langchain.py", fTopo);
  if (drop !== "django-topo")
    write(
      "apps/django-backend/deepagents_backend/ai_backends/langchain.py",
      dTopo
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
  {
    name: "MATCHED    identical planes with sessions pass",
    tree: () => tree({}),
    expect: (r) => r.code === 0 && /byte-identical/.test(r.out),
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
  }. The checker refuses a\n` +
    `      divergence, a missing implementation, a dispatch that records no session,\n` +
    `      a dispatch that records nothing, and an absent source file — for BOTH\n` +
    `      file pairs it compares, including the gated-topology builder (#449).`
);
process.exit(pass === cases.length ? 0 : 1);
