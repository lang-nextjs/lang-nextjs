#!/usr/bin/env node
/**
 * Proof that assert-coverage-follows-the-surface can fail, and that it does not fire on a
 * tree that is fine.
 *
 * BOTH DIRECTIONS, and the ACCEPT half is the larger one on purpose. A checker that flags a
 * clean tree is deleted within a month, and this one joins two noisy sources — a regex over
 * spec sources and a route table off the filesystem. The first hand-built version of this
 * rule called FOURTEEN plainly-chat specs "run-surface" by counting `page.route` stubs as
 * coverage; case STUB below is that mistake, pinned.
 *
 * Every case runs against a THROWAWAY GIT WORKTREE. Nothing here can touch the real tree.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(
  ROOT,
  "scripts",
  "assert-coverage-follows-the-surface.mjs"
);
const worktrees = [];

function sandbox(mutate) {
  const wt = mkdtempSync(join(tmpdir(), "cfts-"));
  execFileSync("git", ["worktree", "add", "-q", "--detach", wt, "HEAD"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  worktrees.push(wt);
  mutate(wt);
  execFileSync("git", ["add", "-A"], { cwd: wt, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "case"],
    { cwd: wt, stdio: "ignore" }
  );
  return wt;
}

function run(wt) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--cwd", wt], { encoding: "utf8" }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** A shared route nobody else serves, so a case owns its own coverage question. */
function addSharedRoute(wt, name) {
  const dir = join(wt, "apps", "example", "app", "api", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "route.ts"),
    "export function GET(): Response {\n  return Response.json({ ok: true });\n}\n"
  );
  return `/api/${name}`;
}
function addSpec(wt, relDir, file, body) {
  const dir = join(wt, "e2e", relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
}
const visits = (url) =>
  `import { test, expect } from "@playwright/test";\ntest("visits", async ({ request }) => {\n  expect((await request.get("${url}")).ok()).toBe(true);\n});\n`;
const stubsOnly = (url) =>
  `import { test, expect } from "@playwright/test";\ntest("stubs", async ({ page }) => {\n  await page.route("**${url}", (r) => r.fulfill({ status: 200, body: "{}" }));\n  expect(1).toBe(1);\n});\n`;

const cases = [];
let pass = 0,
  fail = 0;
const record = (name, ok, detail, out) => {
  if (ok) {
    console.log(`  ok    ${name}`);
    pass++;
  } else {
    console.error(`  FAIL  ${name}   ${detail}`);
    console.error(
      String(out)
        .split("\n")
        .map((l) => `        | ${l}`)
        .join("\n")
    );
    fail++;
  }
};

// ---- REJECT: the defect this exists for ---------------------------------------------------
{
  const wt = sandbox((wt) => {
    const url = addSharedRoute(wt, "zz-probe");
    addSpec(wt, "rungs/open-swe", "open-swe-zz-probe.spec.ts", visits(url));
  });
  const r = run(wt);
  record(
    "REJECT  a shared route covered ONLY by a rung-owned spec is caught",
    r.code === 1 &&
      /\/api\/zz-probe/.test(r.out) &&
      /covered only by/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

// ---- ACCEPT: the same route, plus one shared spec ------------------------------------------
{
  const wt = sandbox((wt) => {
    const url = addSharedRoute(wt, "zz-probe");
    addSpec(wt, "rungs/open-swe", "open-swe-zz-probe.spec.ts", visits(url));
    addSpec(wt, "shell", "zz-probe.spec.ts", visits(url));
  });
  const r = run(wt);
  record(
    "ACCEPT  one surviving shared spec is enough — the rest may travel",
    r.code === 0,
    `exit=${r.code}`,
    r.out
  );
}

// ---- ACCEPT: no e2e coverage at all is a DIFFERENT defect ----------------------------------
{
  const wt = sandbox((wt) => addSharedRoute(wt, "zz-probe"));
  const r = run(wt);
  record(
    "ACCEPT  a shared route with NO e2e coverage is reported, not failed",
    r.code === 0 &&
      /\/api\/zz-probe/.test(r.out) &&
      /no e2e coverage at all/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

// ---- ACCEPT: a rung's OWN route covered by its own specs is correct ------------------------
{
  const wt = sandbox((wt) => {
    // apps/open-swe/app/api/open-swe/** is rung-4-owned, so this route travels with its specs.
    const dir = join(
      wt,
      "apps",
      "open-swe",
      "app",
      "api",
      "open-swe",
      "zz-probe"
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "route.ts"),
      "export function GET(): Response {\n  return Response.json({});\n}\n"
    );
    addSpec(
      wt,
      "rungs/open-swe",
      "open-swe-zz-probe.spec.ts",
      visits("/api/open-swe/zz-probe")
    );
  });
  const r = run(wt);
  record(
    "ACCEPT  a RUNG's own route covered only by rung specs is not a violation",
    r.code === 0,
    `exit=${r.code}`,
    r.out
  );
}

// ---- ACCEPT: a STUB is setup, not coverage — the 14-file false positive --------------------
{
  const wt = sandbox((wt) => {
    const url = addSharedRoute(wt, "zz-probe");
    // A rung spec that only STUBS this route. Counting stubs as coverage would make this a
    // "covered only by a rung spec" violation — which is how fourteen chat specs were first
    // misread as run-surface tests.
    addSpec(wt, "rungs/open-swe", "open-swe-zz-probe.spec.ts", stubsOnly(url));
  });
  const r = run(wt);
  record(
    "ACCEPT  a rung spec that only STUBS a shared route does not count as covering it",
    r.code === 0 && /no e2e coverage at all/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

// ---- REJECT: vacuity — a tree with no routes must REFUSE, not pass -------------------------
{
  const wt = sandbox((wt) =>
    rmSync(join(wt, "apps"), { recursive: true, force: true })
  );
  const r = run(wt);
  record(
    "REFUSE  a tree the walk cannot read exits 2, rather than passing on an empty set",
    r.code === 2 && /too few to have measured anything/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

for (const wt of worktrees) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wt], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {}
  rmSync(wt, { recursive: true, force: true });
}
try {
  execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
} catch {}

const total = pass + fail;
if (total !== 6) {
  console.error(
    `FAIL: ran ${total} cases, expected 6 — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(`\nFAIL: ${fail}/${total}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The checker was watched catching a shared route whose only\n` +
    `      coverage travels with a rung, and watched NOT firing on a mixed set, an\n` +
    `      uncovered route, a rung's own route, or a stub mistaken for coverage.`
);
