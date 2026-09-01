#!/usr/bin/env node
/**
 * The CORS parity checker, watched failing before it is trusted (#349).
 *
 * It is a SOURCE check standing in for a test django cannot have, so it is the
 * only assertion covering one of the three planes. A source check that cannot
 * fail would leave that plane covered by nothing while reading as covered —
 * which is worse than the hardcoded list it replaced, because the list at least
 * did not claim to be checked.
 */
import { execFileSync } from "node:child_process";
import { unaccountedPlanes } from "./check-cors-parity.mjs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CHECKER = join(HERE, "check-cors-parity.mjs");

let failures = 0;
const ok = (n, c, d = "") => {
  console.log(`  ${c ? "ok  " : "FAIL"}   ${n}${d ? `   ${d}` : ""}`);
  if (!c) failures++;
};

const ENV = "CORS_ALLOWED_ORIGINS";
const DEFAULTS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://frontend:3001",
  "http://frontend:3002",
];

const listPy = (o) => o.map((x) => `        "${x}",`).join("\n");
const planeBody = (origins, readsEnv = true) =>
  `${readsEnv ? `raw = os.environ.get("${ENV}")\n` : ""}ORIGINS = [\n${listPy(
    origins
  )}\n]\n`;

function stage({ fastapi, django, node, fixture }) {
  const dir = mkdtempSync(join(tmpdir(), "cors-parity-"));
  const w = (p, b) => {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), b);
  };
  w(
    "scripts/fixtures/cors-origins.json",
    JSON.stringify(
      fixture ?? { envVar: ENV, devDefault: DEFAULTS, parseCases: [] }
    )
  );
  w("apps/fastapi-backend/main.py", fastapi);
  w("apps/django-backend/deepagents_backend/settings.py", django);
  w("apps/node-backend/src/server.ts", node);
  return dir;
}

function run(dir) {
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf-8" });
    return 0;
  } catch (e) {
    return e.status ?? -1;
  }
}

console.log("check-cors-parity selftest\n");

const GOOD = planeBody(DEFAULTS);

/* 0 — the control. */
{
  const d = stage({ fastapi: GOOD, django: GOOD, node: GOOD });
  ok("three agreeing planes PASS", run(d) === 0);
  rmSync(d, { recursive: true, force: true });
}

/* 1 — the defect the issue is about: a plane that cannot be configured. */
{
  const d = stage({
    fastapi: GOOD,
    django: planeBody(DEFAULTS, /* readsEnv */ false),
    node: GOOD,
  });
  ok("a plane that does not read the env var FAILS", run(d) === 1);
  rmSync(d, { recursive: true, force: true });
}

/* 2 — THE DRIFT THAT HAD ALREADY HAPPENED. django really was missing
 *     http://localhost:3000 that the other two allowed, and nothing said so. */
{
  const d = stage({
    fastapi: GOOD,
    django: planeBody(DEFAULTS.filter((o) => o !== "http://localhost:3000")),
    node: GOOD,
  });
  ok("a plane MISSING a declared origin FAILS (the real drift)", run(d) === 1);
  rmSync(d, { recursive: true, force: true });
}

/* 3 — drift the other way. Without this, a plane could keep an extra origin
 *     nobody else has and pass for containing the five it shares. */
{
  const d = stage({
    fastapi: GOOD,
    django: GOOD,
    node: planeBody([...DEFAULTS, "http://sneaky.example"]),
  });
  ok("a plane with an EXTRA origin FAILS", run(d) === 1);
  rmSync(d, { recursive: true, force: true });
}

/* 4 — a missing plane is a hard failure, not a skipped comparison. */
{
  const d = stage({ fastapi: GOOD, django: GOOD, node: GOOD });
  rmSync(join(d, "apps/node-backend/src/server.ts"));
  ok("a MISSING plane FAILS rather than being skipped", run(d) === 1);
  rmSync(d, { recursive: true, force: true });
}

/* 5 — vacuity: an empty declaration must not pass everything. */
{
  const d = stage({
    fastapi: GOOD,
    django: GOOD,
    node: GOOD,
    fixture: { envVar: ENV, devDefault: [], parseCases: [] },
  });
  ok("an EMPTY declared list is an error, not a pass", run(d) === 2);
  rmSync(d, { recursive: true, force: true });
}

/* 6 — the real repo passes, checked last so a green suite is not the only
 *     evidence that the checker works on the tree it ships with. */
ok("the real repository passes", run(REPO) === 0);

/*
 * #602 item 3 — THE PLANE LIST ACCOUNTS FOR THE WORLD.
 *
 * PLANES was a literal three with nothing asserting it covered anything.
 * Measured: adding apps/edge-backend/src/server.ts, which reads the env var and
 * defaults to a DIFFERENT origin, produced a byte-identical report at exit 0. A
 * fourth backend could disagree about which origins are allowed and this check
 * would report that all three agree.
 *
 * The CONTROL is first. Every other case asserts a refusal, and a suite of only
 * refusals stays green if the function has stopped finding anything at all.
 */
ok(
  "CONTROL: every referencing file accounted for reports nothing",
  (() => {
    const r = unaccountedPlanes(
      ["apps/a/main.py", "scripts/fixtures/x.json", ".planning/p.md"],
      ["apps/a/main.py"],
      ["scripts/", ".planning/"]
    );
    return !r.unaccounted.length && !r.phantom.length;
  })()
);
ok(
  "PLANT: a referencing file in neither list is reported",
  unaccountedPlanes(
    ["apps/a/main.py", "apps/edge-backend/src/server.ts"],
    ["apps/a/main.py"],
    ["scripts/"]
  ).unaccounted.join() === "apps/edge-backend/src/server.ts"
);
ok(
  "PLANT: a listed plane that no longer references the var is reported",
  unaccountedPlanes(
    ["apps/a/main.py"],
    ["apps/a/main.py", "apps/gone/main.py"],
    []
  ).phantom.join() === "apps/gone/main.py"
);
ok(
  "GUARD: an excluded PREFIX does not silently swallow a real plane under it",
  unaccountedPlanes(["scripts/fixtures/x.json"], [], ["scripts/"]).unaccounted
    .length === 0 &&
    unaccountedPlanes(["apps/x/main.py"], [], ["scripts/"]).unaccounted
      .length === 1
);

console.log(
  failures === 0
    ? "\nPASS: the checker refuses an unconfigurable plane, drift in BOTH\n" +
        "      directions, a missing plane and an empty declaration."
    : `\nFAIL: ${failures} check(s) failed. Do not trust this checker.`
);
process.exit(failures === 0 ? 0 : 1);
