#!/usr/bin/env node
/**
 * Proof that assert-decision-parity can fail, and on what (#668).
 *
 * THE CASE THIS CHECKER EXISTS FOR IS THE ANTI-GREP ONE. A suite that NAMES all
 * four decisions in a docstring and SENDS three is exactly what a text search
 * passes, and it is the shape this whole area keeps producing. So the fixture
 * writes the word into prose while removing it from the payload, and the check
 * must still call the plane short. Without that case the rest of this file would
 * be satisfied by a grep.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-decision-parity.mjs");

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(
    `  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? "   " + detail : ""}`
  );
  if (!cond) failures++;
};

const COMMON = '_DECISION_TYPES = ("approve", "edit", "reject", "respond")\n';

/** A suite: a resume helper plus one call per decision it drives. */
const suite = ({
  drives,
  helperField = "approvalDecisions",
  prose = "",
  extraCall = "",
}) =>
  `"""${prose}"""\n\n` +
  `def _resume(client, decisions):\n` +
  `    body = {"sessionId": "s", "${helperField}": decisions}\n` +
  `    return client.post("/x", json=body)\n\n\n` +
  drives
    .map(
      (d, i) =>
        `def test_${d}_${i}():\n    res = _resume(client, [{"type": "${d}"}])\n`
    )
    .join("\n") +
  extraCall;

const PLANES = {
  fastapi: {
    tests: "apps/fastapi-backend/tests",
    common: "apps/fastapi-backend/ai_backends/_common.py",
  },
  django: {
    tests: "apps/django-backend/tests",
    common: "apps/django-backend/deepagents_backend/ai_backends/_common.py",
  },
};

function tree({ fastapi, django, planes = ["fastapi", "django"] }) {
  const root = mkdtempSync(join(tmpdir(), "decision-parity-"));
  const write = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const bodies = { fastapi, django };
  for (const plane of planes) {
    write(PLANES[plane].common, COMMON);
    if (bodies[plane] !== null)
      write(`${PLANES[plane].tests}/test_approval_dispatch.py`, bodies[plane]);
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

const ALL = ["approve", "edit", "reject", "respond"];

console.log("assert-decision-parity selftest\n");

let r = run(
  tree({ fastapi: suite({ drives: ALL }), django: suite({ drives: ALL }) })
);
ok(
  "MATCHED   both planes drive all four -> PASS",
  r.code === 0 && /same 4 decision type/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    fastapi: suite({ drives: ALL }),
    django: suite({ drives: ["approve", "edit", "reject"] }),
  })
);
ok(
  "SHORT     one plane drives three -> REJECTED, and NAMES the plane and the type",
  r.code === 1 && /django does not drive \[respond\]/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    fastapi: suite({ drives: ALL }),
    django: suite({
      drives: ["approve", "edit", "reject"],
      prose: "drives approve, edit, reject and respond",
    }),
  })
);
ok(
  "ANTI-GREP the word is in the prose and NOT in a payload -> still REJECTED",
  r.code === 1 && /django does not drive \[respond\]/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    fastapi: suite({ drives: ALL }),
    django: suite({
      drives: ALL,
      extraCall: `\ndef test_var():\n    p = [{"type": "approve"}]\n    _resume(client, p)\n`,
    }),
  })
);
ok(
  "UNREADABLE a payload passed as a variable -> REFUSES with exit 2",
  r.code === 2 && /cannot be read from source/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    fastapi: suite({ drives: ALL }),
    django: suite({ drives: ALL, helperField: "somethingElse" }),
  })
);
ok(
  "NO-HELPER nothing writes the wire field -> REJECTED, saying the subject was lost",
  r.code === 1 && /NO function that puts a parameter/.test(r.out),
  `exit ${r.code}`
);

r = run(
  tree({
    fastapi: suite({ drives: ALL }),
    django: null,
    planes: ["fastapi", "django"],
  })
);
ok(
  "ONE-PLANE a plane with no test files is not compared against",
  r.code === 0,
  `exit ${r.code}`
);

r = run(
  tree({
    fastapi: suite({ drives: ALL }),
    django: suite({ drives: ALL }),
    planes: ["fastapi"],
  })
);
ok(
  "EJECTED   a plane absent from the tree is not a finding",
  r.code === 0 && /only the fastapi plane is present/.test(r.out),
  `exit ${r.code}`
);

// A tree whose vocabulary cannot be read must not pass by comparing nothing.
{
  const root = tree({
    fastapi: suite({ drives: ALL }),
    django: suite({ drives: ALL }),
  });
  for (const p of Object.values(PLANES))
    writeFileSync(join(root, p.common), "# no vocabulary here\n");
  r = run(root);
  ok(
    "NO-VOCAB  _DECISION_TYPES unreadable -> REFUSES rather than comparing empty sets",
    r.code === 2 && /_DECISION_TYPES could not be read/.test(r.out),
    `exit ${r.code}`
  );
}

console.log(
  failures === 0
    ? "\nPASS: the checker was watched calling a plane short, refusing a payload it\n" +
        "      could not read, refusing a tree whose vocabulary it could not read, and\n" +
        "      saying so when the wire field went unwritten — while leaving an ejected\n" +
        "      plane alone. And it still called the plane short when the missing\n" +
        "      decision was NAMED in prose, which is the case a grep would pass."
    : `\nFAIL: ${failures} case(s) failed. Do not trust this checker's output.`
);
process.exit(failures === 0 ? 0 : 1);
