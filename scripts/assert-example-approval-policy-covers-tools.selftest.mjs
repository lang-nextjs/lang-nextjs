#!/usr/bin/env node
/**
 * Prove the classification check can fail, in each direction (#653).
 *
 * PLANT, DON'T BORROW. Every fixture is a temp tree. The real tree agrees today,
 * so borrowing it would give a selftest that is green because the repo is healthy.
 *
 * CASE 5 IS THE VACUITY FLOOR AND IT IS THE ONE THAT MATTERS MOST HERE. This
 * checker's whole job is comparing two parsed lists, and BOTH parsers are
 * regexes over source. A decorator form it cannot read yields an empty inventory,
 * against which every classification is vacuously phantom-free and complete — a
 * clean union over nothing. It must REFUSE. Nothing else in this file catches a
 * parser that went blind.
 *
 * CASE 8 keeps the fork skip honest: a checker that skipped whenever it felt like
 * it would satisfy case 7 and prove nothing.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(
  HERE,
  "assert-example-approval-policy-covers-tools.mjs"
);
let pass = 0,
  fail = 0;

const PY = (names, decorator = "@tool") =>
  names
    .map((n) => `${decorator}\ndef ${n}(x: int) -> int:\n    return x\n`)
    .join("\n");
const TS = (ro, gated) =>
  `export const READ_ONLY_TOOLS: readonly string[] = [${ro
    .map((s) => `"${s}"`)
    .join(", ")}];\n` +
  `export const GATED_TOOLS: readonly string[] = [${gated
    .map((s) => `"${s}"`)
    .join(", ")}];\n`;

function tree({ django, fastapi, policy }) {
  const root = mkdtempSync(path.join(tmpdir(), "toolpolicy-"));
  const put = (rel, body) => {
    if (body === null) return;
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  put("apps/django-backend/deepagents_backend/ai_backends/_common.py", django);
  put("apps/fastapi-backend/ai_backends/_common.py", fastapi);
  put("apps/example/lib/approval-policy.ts", policy);
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
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function expectExit(name, spec, wantCode, mustMention) {
  const root = tree(spec);
  try {
    // The checker resolves paths from its OWN location, so it is run with cwd at
    // the fixture and given the fixture root explicitly by env-free convention:
    // it reads ROOT-relative paths, so we copy it in.
    const { code, out } = runIn(root);
    const ok = code === wantCode && (!mustMention || out.includes(mustMention));
    ok ? pass++ : fail++;
    console.log(
      ok
        ? `  ok   ${name} -> exit ${code}`
        : `  FAIL ${name}\n       want ${wantCode}${
            mustMention ? ` mentioning "${mustMention}"` : ""
          }\n       got  ${code}: ${out.trim().slice(0, 200)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Copy the checker into the fixture's scripts/ so its ROOT is the fixture. */
function runIn(root) {
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  const dest = path.join(root, "scripts", path.basename(CHECKER));
  writeFileSync(dest, require_fs_read(CHECKER));
  /*
   * THE CHECKER'S SIBLINGS COME WITH IT (#741). Copying the file alone made the
   * sandbox a tree the checker cannot run in: it imports ./lib/subject.mjs to
   * report what it examined, and the copy resolved that against a scripts/ that
   * had no lib/. Every case then failed with ERR_MODULE_NOT_FOUND and the proof
   * reported the CHECKER as broken.
   *
   * A sandbox that omits what the subject needs is not a smaller tree, it is a
   * different one — and the failure it produces is attributed to the thing being
   * tested rather than to the fixture.
   */
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  const lib = path.join(path.dirname(CHECKER), "lib", "subject.mjs");
  writeFileSync(
    path.join(root, "scripts", "lib", "subject.mjs"),
    require_fs_read(lib)
  );
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [dest], { encoding: "utf8" }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
function require_fs_read(p) {
  return execFileSync(
    process.execPath,
    [
      "-e",
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(
        p
      )},"utf8"))`,
    ],
    { encoding: "utf8" }
  );
}

const THREE = ["increment", "get_counter", "web_search"];
console.log("assert-example-approval-policy-covers-tools selftest");

expectExit(
  "0 CONTROL: classification is total and disjoint",
  {
    django: PY(THREE),
    fastapi: PY(THREE),
    policy: TS(["get_counter", "web_search"], ["increment"]),
  },
  0,
  "PASS"
);

expectExit(
  "1 a NEW backend tool classified nowhere -> FAILS and names it",
  {
    django: PY([...THREE, "delete_everything"]),
    fastapi: PY([...THREE, "delete_everything"]),
    policy: TS(["get_counter", "web_search"], ["increment"]),
  },
  1,
  "delete_everything"
);

expectExit(
  "2 a PHANTOM entry the backend no longer has -> FAILS and names it",
  {
    django: PY(["increment", "get_counter"]),
    fastapi: PY(["increment", "get_counter"]),
    policy: TS(["get_counter", "web_search"], ["increment"]),
  },
  1,
  "web_search"
);

expectExit(
  "3 a name in BOTH lists -> FAILS",
  {
    django: PY(THREE),
    fastapi: PY(THREE),
    policy: TS(["get_counter", "web_search", "increment"], ["increment"]),
  },
  1,
  "BOTH lists"
);

// 5. THE VACUITY FLOOR.
expectExit(
  "4 a decorator form it cannot read -> REFUSES, does not report a clean union",
  {
    django: PY(THREE, "@tool(parse_docstring=True)\n@another"),
    fastapi: PY(THREE, "@tool(parse_docstring=True)\n@another"),
    policy: TS(["get_counter", "web_search"], ["increment"]),
  },
  2,
  "went blind"
);

expectExit(
  "5 the two planes disagree -> REFUSES rather than picking one",
  {
    django: PY(THREE),
    fastapi: PY(["increment", "get_counter"]),
    policy: TS(["get_counter", "web_search"], ["increment"]),
  },
  2,
  "different @tool sets"
);

expectExit(
  "6 no Python plane (ejected) -> SKIPS",
  { django: null, fastapi: null, policy: TS(["get_counter"], ["increment"]) },
  0,
  "SKIPPED"
);

expectExit(
  "7 a plane IS present -> does NOT skip (makes case 6 mean something)",
  {
    django: PY(THREE),
    fastapi: null,
    policy: TS(["get_counter"], ["increment"]),
  },
  1,
  "web_search"
);

expectExit(
  "8 an unreadable export -> REFUSES",
  {
    django: PY(THREE),
    fastapi: PY(THREE),
    policy:
      'export const READ_ONLY_TOOLS = buildIt();\nexport const GATED_TOOLS: readonly string[] = ["increment"];\n',
  },
  2,
  "no readable"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
