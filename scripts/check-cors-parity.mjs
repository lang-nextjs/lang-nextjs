#!/usr/bin/env node
/**
 * ONE CORS ALLOWLIST, THREE BACKENDS, ASSERTED (#349).
 *
 * All three hardcoded the same dev origins and none read an environment
 * variable, so a fork had no supported way to change the allowlist at deploy
 * time. The sharper framing is three lines from django's own list:
 *
 *   SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'dev-insecure-key-do-not-use-in-prod')
 *
 * A dev default, an environment override, and a name that says it is a dev
 * default. `DATABASE_URL` and `REDIS_URL` follow it. CORS got the dev default
 * and NEITHER of the other two — so the one value that silently keeps working
 * in production when it is wrong was the only one with no override.
 *
 * THE COPIES HAD ALREADY DRIFTED, which is the argument for this file rather
 * than for three careful edits: fastapi and node allowed http://localhost:3000
 * and django did not. Nobody decided that. It is what three hand-maintained
 * lists do, and nothing would have told anyone.
 *
 * WHY A SOURCE CHECK AND NOT THREE TESTS. The django backend has no test
 * harness and `pnpm` cannot see it — it has no package.json. That is the same
 * constraint check-run-axes-parity.mjs and check-langfuse-wiring.mjs work
 * around, the same way. fastapi and node DO have harnesses and assert the
 * behaviour directly; this asserts the thing no test could, which is that all
 * three still agree with one declared list.
 *
 * NOT A SUBSTITUTE FOR THE BEHAVIOURAL TESTS. This reads source. It can tell
 * you the three lists match; it cannot tell you a request from an unlisted
 * origin is refused. Both exist, and they fail on different things.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FIXTURE = "scripts/fixtures/cors-origins.json";

const PLANES = {
  fastapi: "apps/fastapi-backend/main.py",
  django: "apps/django-backend/deepagents_backend/settings.py",
  node: "apps/node-backend/src/server.ts",
};

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

/* A missing fixture is a hard failure, not "nothing to compare". */
if (!existsSync(join(ROOT, FIXTURE))) {
  console.error(
    `FAIL: ${FIXTURE} is missing — there is no declared list to compare against.`
  );
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(join(ROOT, FIXTURE), "utf-8"));
const { envVar, devDefault } = fixture;

if (!envVar || !Array.isArray(devDefault) || devDefault.length === 0) {
  console.error(
    "FAIL: the fixture declares no envVar or an empty devDefault — a check with no subject is vacuous."
  );
  process.exit(2);
}

let compared = 0;
for (const [plane, path] of Object.entries(PLANES)) {
  const abs = join(ROOT, path);
  /*
   * A MISSING PLANE IS A HARD FAILURE, not a skipped comparison. A fork that
   * ejects a backend deletes it from PLANES here; a file that has merely moved
   * would otherwise turn this check into a quieter and quieter no-op.
   */
  if (!existsSync(abs)) {
    fail(`${plane}: ${path} does not exist`);
    continue;
  }
  const src = readFileSync(abs, "utf-8");
  compared++;

  if (!src.includes(envVar)) {
    fail(
      `${plane} (${path}) does not read ${envVar} — its allowlist cannot be configured at deploy time, which is the whole of #349.`
    );
    continue;
  }

  /*
   * Every declared default origin must appear, and no OTHER http(s) origin may.
   * The second half is what catches drift: without it, a plane that kept an
   * extra origin nobody else has would pass for containing the five it shares.
   */
  const missing = devDefault.filter((o) => !src.includes(o));
  if (missing.length) {
    fail(`${plane} is missing default origin(s): ${missing.join(", ")}`);
  }
  /*
   * SCOPED TO THE DECLARATION BLOCK, not the whole file. Scanning the file
   * flagged node's `new URL(req.url ?? "/", "http://localhost")` — a parsing
   * base, not an allowlist entry. A checker that reports a URL used for
   * something else entirely trains people to stop reading its output.
   */
  const first = Math.min(
    ...devDefault.map((o) => src.indexOf(o)).filter((i) => i >= 0)
  );
  const last = Math.max(...devDefault.map((o) => src.lastIndexOf(o)));
  const block = src.slice(first, last + 64);
  const found = new Set(
    [...block.matchAll(/["']((?:https?:\/\/)[A-Za-z0-9.:_-]+)["']/g)].map(
      (m) => m[1]
    )
  );
  const extra = [...found].filter((o) => !devDefault.includes(o));
  if (extra.length) {
    fail(
      `${plane} allows origin(s) the fixture does not declare: ${extra.join(
        ", "
      )}`
    );
  }
}

if (compared !== Object.keys(PLANES).length) {
  console.error(
    `FAIL: compared ${compared} of ${Object.keys(PLANES).length} planes.`
  );
  process.exitCode = 1;
}

if (process.exitCode) {
  console.error(
    `\nThe declared list is ${FIXTURE}. Change it there, then make the backends agree.`
  );
} else {
  console.log(
    `PASS: ${compared} backends read ${envVar} and default to the same ${devDefault.length} origins.\n` +
      `      Source-level only — that a request from an unlisted origin is REFUSED is\n` +
      `      asserted by the fastapi and node test suites, which this does not replace.`
  );
}
