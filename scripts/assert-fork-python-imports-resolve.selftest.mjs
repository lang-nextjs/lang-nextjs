#!/usr/bin/env node
/**
 * Proof for assert-fork-python-imports-resolve.mjs.
 *
 * THE CHECK EXISTS BECAUSE NOTHING ELSE COULD SEE #565: a SHARED test importing a RUNG-OWNED
 * module collects fine in the full tree and dies with an ImportError in every fork below that
 * rung. `ruff --select F821` is undefined NAMES, not unresolvable imports; the boot check
 * executes only the graph reachable at boot, and a test module is not.
 *
 * THE PRECISION PROPERTY IS THE ONE THAT DECIDES WHETHER THIS IS USABLE. A resolver that
 * flagged third-party imports would fire on every `import fastapi` in a tree without the
 * requirements installed — noise, and it would be muted within a day. So `ACCEPT a third-party
 * import` below is not a nicety; it is the case that makes the check's reds mean something.
 *
 * WHY NOT `pytest --collect-only` AS THE GATE, which is ground truth: it cannot separate a
 * missing LOCAL module from a missing DEPENDENCY. Measured while building this — on a machine
 * without langchain installed, pytest reported 10 collection errors in the FULL tree and 11 in
 * the fork, so the one eject-caused failure was visible only by differencing the two, and the
 * other two instances were masked entirely. This resolver reports all three regardless of what
 * is installed, which is exactly the separation an eject leg needs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-fork-python-imports-resolve.mjs");
const QUIET = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
const dirs = [];

function repo(files) {
  const d = mkdtempSync(join(tmpdir(), "fork-py-imports-"));
  dirs.push(d);
  execFileSync("git", ["-C", d, "init", "-q", "-b", "main"], QUIET);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  execFileSync("git", ["-C", d, "add", "-A"], QUIET);
  return d;
}

function run(d) {
  try {
    return { code: 0, out: execFileSync("node", [CHECKER, "--cwd", d], QUIET) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let pass = 0, fail = 0;
const check = (name, ok, detail, out) => {
  if (ok) { console.log(`  ok      ${name}`); pass++; }
  else {
    console.error(`  FAIL    ${name}  ${detail}`);
    console.error(String(out).split("\n").map((l) => `          | ${l}`).join("\n"));
    fail++;
  }
};

/* --------------------------------------------------------------------- REJECT: the #565 shape */
{
  const d = repo({
    "rungs.json": "{}\n",
    "apps/be/ai_backends/__init__.py": "from . import _common\n",
    "apps/be/ai_backends/_common.py": "async def guarded_stream(x):\n    return x\n",
    // deepagents.py is ABSENT — this is the fork, after the rung left
    "apps/be/tests/test_turn_usage.py": "from ai_backends import deepagents\n",
  });
  const r = run(d);
  check(
    "REJECT  a surviving test importing a module the eject deleted (#565)",
    r.code === 1 && /test_turn_usage\.py/.test(r.out) && /deepagents/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  // The same tree WITH the module present must be clean, or the case above proves nothing about
  // the import and only something about the file existing at all.
  const d = repo({
    "rungs.json": "{}\n",
    "apps/be/ai_backends/__init__.py": "from . import _common\n",
    "apps/be/ai_backends/_common.py": "async def guarded_stream(x):\n    return x\n",
    "apps/be/ai_backends/deepagents.py": "VALUE = 1\n",
    "apps/be/tests/test_turn_usage.py": "from ai_backends import deepagents\n",
  });
  const r = run(d);
  check("ACCEPT  ...and the identical tree WITH the module resolves clean", r.code === 0, `exit=${r.code}`, r.out);
}

/* ------------------------------------------------- ACCEPT: the precision cases that decide use */
{
  const d = repo({
    "rungs.json": "{}\n",
    "apps/be/main.py": "import fastapi\nfrom langchain_core.messages import AIMessage\nimport json\n",
  });
  const r = run(d);
  check(
    "ACCEPT  third-party and stdlib imports are NOT this check's subject",
    r.code === 0,
    `exit=${r.code} — flagging these would make it red on every uninstalled tree, i.e. noise`,
    r.out
  );
}
{
  /*
   * `async def` IS A BINDING, and the first version of the resolver did not know it: it reported
   * two false positives on a CLEAN tree (`guarded_stream`, `_stream_agent_events`). A checker
   * that cries wolf on main is worse than the blindness it replaces.
   */
  const d = repo({
    "rungs.json": "{}\n",
    "apps/be/ai_backends/__init__.py": "",
    "apps/be/ai_backends/_common.py": "async def guarded_stream(x):\n    return x\n",
    "apps/be/tests/t.py": "from ai_backends._common import guarded_stream\n",
  });
  const r = run(d);
  check("ACCEPT  a symbol bound by `async def` is found, not reported missing", r.code === 0, `exit=${r.code}`, r.out);
}
{
  const d = repo({
    "rungs.json": "{}\n",
    "apps/be/pkg/__init__.py": "",
    "apps/be/pkg/sub.py": "X = 1\n",
    "apps/be/tests/t.py": "from .helpers import thing\n",
    "apps/be/tests/helpers.py": "thing = 1\n",
  });
  const r = run(d);
  check("ACCEPT  a relative import resolves against its own package, not the app root", r.code === 0, `exit=${r.code}`, r.out);
}

/* --------------------------------------------------------------------------------- REFUSALS */
{
  const d = repo({ "rungs.json": "{}\n", "README.md": "no python here\n" });
  const r = run(d);
  check(
    "a tree with NO python says so rather than reporting a clean scan of nothing",
    r.code === 0 && /no tracked Python files/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  const r = run(join(tmpdir(), "definitely-not-a-checkout-565"));
  check("REFUSE  a directory that is not a checkout exits 2", r.code === 2, `exit=${r.code}`, r.out);
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

const EXPECTED = 7;
const total = pass + fail;
if (total !== EXPECTED) {
  console.error(`\nFAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`);
  process.exit(1);
}
if (fail > 0) {
  console.error(`\nFAIL: ${fail}/${total}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Watched it FIRE on a surviving test whose module the eject deleted,\n` +
    `      and stay quiet for the same tree with the module present, for third-party and stdlib\n` +
    `      imports, for a symbol bound by \`async def\`, and for a relative import. Watched it\n` +
    `      REFUSE a directory that is not a checkout, and SAY SO rather than reporting a clean\n` +
    `      scan when a tree has no Python at all.`
);
