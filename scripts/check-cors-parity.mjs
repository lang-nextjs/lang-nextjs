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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FIXTURE = "scripts/fixtures/cors-origins.json";

const PLANES = {
  fastapi: "apps/fastapi-backend/main.py",
  django: "apps/django-backend/deepagents_backend/settings.py",
  node: "apps/node-backend/src/server.ts",
};

/**
 * Prefixes where a reference to the env var is NOT a backend configuring CORS,
 * each with the reason (#602 item 3).
 *
 * WHY THIS EXISTS. PLANES is a literal list of three, and nothing asserted it
 * covered the world. Measured: adding apps/edge-backend/src/server.ts, reading
 * CORS_ALLOWED_ORIGINS with a WRONG default origin, produced a BYTE-IDENTICAL
 * report at exit 0. A fourth backend could disagree with the other three about
 * which origins are allowed and this check would say all three agree.
 *
 * The population here is enumerable and it is a property of CONTENT: files that
 * reference the env var. That is exactly this checker's subject, so unlike a
 * directory walk it is not a proxy for the question.
 */
const NOT_PLANES = {
  ".planning/":
    "Archival planning documents. They describe decisions rather than " +
    "configure a server, and they are historical keys that must not be " +
    "rewritten when the code moves.",
  ".github/":
    "CI tooling. semgrep_triage.py names the variable to triage findings " +
    "about it; it does not set an allowlist any request is checked against.",
  "scripts/":
    "This checker's own machinery — the fixture it reads and the proof that " +
    "plants defects in it. A checker's fixture is not a plane.",
};

/**
 * Files referencing the env var that are in NEITHER the plane list nor the
 * excluded prefixes, and planes whose file has gone.
 *
 * Pure and exported so the proof can plant both directions.
 */
export function unaccountedPlanes(referencing, planePaths, excludedPrefixes) {
  const planes = new Set(planePaths);
  return {
    unaccounted: referencing.filter(
      (f) =>
        !planes.has(f) && !excludedPrefixes.some((pre) => f.startsWith(pre))
    ),
    phantom: planePaths.filter((f) => !referencing.includes(f)),
  };
}

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
// TOTALITY OVER THE PLANES, BEFORE COMPARING THEM. A backend nobody listed is
// reported here rather than silently left out of the comparison.
{
  // ENUMERATED FROM THE FILESYSTEM, NOT FROM GIT. The first version shelled out
  // to `git grep --untracked`, which made the checker require a repository — and
  // the selftest's fixture trees are plain temp directories, so its "three
  // agreeing planes PASS" control went red. That control was right: a checker
  // that only works inside a repo cannot be exercised by a fixture, and a
  // fixture that cannot exercise it is not a proof. A walk also sees files git
  // has not been told about, which is the moment this most needs to fire.
  const IGNORED = new Set([
    "node_modules",
    "dist",
    ".git",
    ".turbo",
    ".next",
    "coverage",
    "__pycache__",
  ]);
  const walk = (dir) => {
    const out = [];
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (IGNORED.has(e.name)) continue;
      const rel = dir === "." ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(rel));
      else out.push(rel);
    }
    return out;
  };
  const referencing = walk(".").filter((f) => {
    try {
      return readFileSync(join(ROOT, f), "utf-8").includes(envVar);
    } catch {
      return false; // unreadable or binary — cannot configure CORS from here
    }
  });

  if (referencing.length === 0) {
    fail(
      `ZERO files reference ${envVar}. The fixture itself names it, so an empty ` +
        `result is a broken enumeration rather than an empty world.`
    );
  }
  const { unaccounted, phantom } = unaccountedPlanes(
    referencing,
    Object.values(PLANES),
    Object.keys(NOT_PLANES)
  );
  if (unaccounted.length || phantom.length) {
    for (const f of unaccounted) {
      console.error(
        `FAIL: ${f} references ${envVar} and is in neither PLANES nor ` +
          `NOT_PLANES. If it is a backend, add it to PLANES so its origins are ` +
          `compared; if it is not, exclude it with the reason. A plane nobody ` +
          `listed is not compared, and its origins can disagree silently.`
      );
    }
    for (const f of phantom) {
      console.error(
        `FAIL: ${f} is listed in PLANES but no longer references ${envVar}. ` +
          `A plane that stopped configuring CORS is either a real regression or ` +
          `a stale entry; both need a human.`
      );
    }
    process.exit(1);
  }
}

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
