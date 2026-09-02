#!/usr/bin/env node
/**
 * Proof that assert-checkpointer-seam can fail, and on what (#643).
 *
 * The checker's whole value is catching a rung that quietly builds its own saver
 * — a defect that leaves every approval test green. So the cases below are
 * written as trees that SHOULD be rejected, plus the ones that must not be:
 * an ungated rung has no checkpointer to get wrong, and an ejected plane is not
 * a finding.
 *
 * THE FIXTURE WRITES BOTH PLANES, because the drift the checker exists for spans
 * them: six declarations, three per plane.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-checkpointer-seam.mjs");
const LIB = resolve(HERE, "lib");

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(
    `  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? "   " + detail : ""}`
  );
  if (!cond) failures++;
};

/** A backend module: its gated set, and how it gets a checkpointer. */
// `gated` is the INNER text of frozenset(...): '{"react"}' gates, "" does not.
// The first draft passed "()" for ungated, producing `frozenset(())`, which is a
// non-empty declaration the checker correctly read as gating — a fixture bug that
// looked exactly like two checker bugs until the fixture was read.
const backend = ({
  gated = '{"react"}',
  saver = "checkpointer=approval_saver(__name__),",
} = {}) =>
  `from ._common import approval_saver\n\n\n` +
  `def get_gated_react_graph():\n    return create_agent(\n        ${saver}\n    )\n\n\n` +
  `GATED_TOPOLOGIES = frozenset(${gated})\n`;

const PLANES = {
  fastapi: "apps/fastapi-backend/ai_backends",
  django: "apps/django-backend/deepagents_backend/ai_backends",
};

/** `rungs` maps "plane/rung" -> backend() options; absent keys are not written. */
function tree(rungs, { planes = Object.keys(PLANES) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ckpt-seam-"));
  // The checker imports ./lib/python-const.mjs relative to ITSELF, so the fixture
  // needs no copy of it — but it does need a repo-shaped tree.
  for (const plane of planes) {
    for (const rung of ["langchain", "langgraph", "deepagents"]) {
      const key = `${plane}/${rung}`;
      const opts = rungs[key] ?? {};
      if (opts === null) continue;
      const p = join(root, PLANES[plane], `${rung}.py`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, backend(opts));
    }
  }
  return root;
}

function run(root) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CHECKER], {
        cwd: root,
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

console.log("assert-checkpointer-seam selftest\n");

let r = run(tree({}));
ok(
  "MATCHED   all six resolve through the seam -> PASS",
  r.code === 0 && /all 6 gating backend/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({ "django/langgraph": { saver: "checkpointer=InMemorySaver()," } })
);
ok(
  "DIRECT    one rung builds its own saver -> REJECTED, and NAMED",
  r.code === 1 &&
    /django-backend[^\n]*langgraph\.py/.test(r.out) &&
    /constructs a checkpointer directly/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    "fastapi/deepagents": { saver: 'checkpointer=approval_saver("shared"),' },
  })
);
ok(
  "LITERAL   a hardcoded scope -> REJECTED, and NAMED with the line",
  r.code === 1 &&
    /fastapi-backend[^\n]*deepagents\.py:\d+/.test(r.out) &&
    /share one saver/.test(r.out),
  `exit ${r.code}`
);

r = run(tree({ "fastapi/langchain": { saver: "" } }));
ok(
  "MISSING   gates but passes no checkpointer -> REJECTED",
  r.code === 1 && /passes no checkpointer/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    "fastapi/deepagents": { gated: "", saver: "checkpointer=InMemorySaver()," },
  })
);
ok(
  "UNGATED   an ungated rung is not judged (it builds no gated graph)",
  r.code === 0,
  `exit ${r.code}`
);

r = run(tree({}, { planes: ["fastapi"] }));
ok(
  "EJECTED   a plane absent from the tree is not a finding",
  r.code === 0 && /all 3 gating backend/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    "fastapi/langchain": { gated: "" },
    "fastapi/langgraph": { gated: "" },
    "fastapi/deepagents": { gated: "" },
    "django/langchain": { gated: "" },
    "django/langgraph": { gated: "" },
    "django/deepagents": { gated: "" },
  })
);
ok(
  "VACUOUS   planes present but NOTHING gates -> REFUSES with exit 2",
  r.code === 2 && /NO gating rung was examined/.test(r.out),
  `exit ${r.code}`
);

console.log(
  failures === 0
    ? "\nPASS: the checker was watched refusing a rung that builds its own saver,\n" +
        "      one that hardcodes a scope, and one that passes none — while leaving\n" +
        "      an ungated rung and an ejected plane alone, and refusing a tree where\n" +
        "      it would have examined nothing."
    : `\nFAIL: ${failures} case(s) failed. Do not trust this checker's output.`
);
process.exit(failures === 0 ? 0 : 1);
