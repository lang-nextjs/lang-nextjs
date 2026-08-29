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

const FN_A = `def set_run_axes(**axes) -> None:
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
`;

const DISPATCH_OK = `def view(body):
    _common.set_run_axes(
        runtime="x",
        framework=body["f"],
        topology=body["t"],
        session=body.get("sessionId"),
    )
`;

function tree({ fastapi = FN_A, django = FN_A, fDisp = DISPATCH_OK, dDisp = DISPATCH_OK, drop = null }) {
  const root = mkdtempSync(join(tmpdir(), "axes-parity-"));
  const write = (rel, text) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  if (drop !== "fastapi-common") write("apps/fastapi-backend/ai_backends/_common.py", fastapi);
  if (drop !== "django-common")
    write("apps/django-backend/deepagents_backend/ai_backends/_common.py", django);
  write("apps/fastapi-backend/main.py", fDisp);
  write("apps/django-backend/deepagents_backend/views.py", dDisp);
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync("node", [CHECKER], { cwd: root, encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const cases = [
  {
    name: "DIVERGED   the two implementations differ",
    tree: () => tree({ django: FN_A.replace('axes.pop("session", None)', "None") }),
    expect: (r) => r.code === 1 && /langfuse_trace_metadata\(\) DIFFERS/.test(r.out),
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
  if (!ok) console.log(`        exit=${r.code}\n        ${r.out.trim().split("\n").join("\n        ")}`);
  if (ok) pass++;
  rmSync(root, { recursive: true, force: true });
}

console.log(
  `\n${pass === cases.length ? "PASS" : "FAIL"}: ${pass}/${cases.length}. The checker refuses a\n` +
    `      divergence, a missing implementation, a dispatch that records no session,\n` +
    `      a dispatch that records nothing, and an absent source file.`
);
process.exit(pass === cases.length ? 0 : 1);
