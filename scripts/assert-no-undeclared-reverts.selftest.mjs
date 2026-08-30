#!/usr/bin/env node
/**
 * Proof that assert-no-undeclared-reverts can fail, and that it does not fire on the shapes a
 * revert check MUST let through.
 *
 * THE REAL SPECIMEN IS THE HEADLINE CASE. `specimen/stale-tree-reverts-398` (`57cfa40`) is a
 * preserved branch that reverted three merged PRs with every pre-merge gate green. A check for
 * #406 that does not fire on it has not been tested, because a mutation someone prescribes can
 * be a silent no-op while a real defect cannot. That case is not optional and does not skip.
 *
 * THE CONSTRUCTED CASES ARE REAL GIT REPOSITORIES, not string fixtures — real commits, real
 * blobs, real history, driven through the same `git log --raw` path as production. Each builder
 * ASSERTS THE SHAPE IT CLAIMS TO HAVE BUILT before the checker ever sees it (`mustRevert` /
 * `mustNotRevert`), because a fixture that failed to plant its defect would make a REJECT case
 * pass for the wrong reason — which is the failure mode this repo keeps finding.
 *
 * THE CASE THIS CHECKER WOULD DIE OF is `ACCEPT prose about reverting`. The specimen's own
 * commit message contains "could be reverted to the exact pre-#360 behaviour with a green
 * suite" — a sentence about reverting, inside the commit that reverts three PRs by accident. A
 * declaration matcher built on the word "revert" would ACCEPT the specimen, and the check would
 * ship inverted while every case here still passed. That sentence is used verbatim below.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-no-undeclared-reverts.mjs");
const dirs = [];

const QUIET = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };

const git = (d, ...a) =>
  execFileSync("git", ["-C", d, ...a], { ...QUIET, maxBuffer: 1 << 26 }).trim();

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "undeclared-reverts-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  execFileSync("git", ["-C", d, "config", "user.email", "probe@example.invalid"], QUIET);
  execFileSync("git", ["-C", d, "config", "user.name", "probe"], QUIET);
  execFileSync("git", ["-C", d, "config", "commit.gpgsign", "false"], QUIET);
  // The checker refuses when its derived-artifact exemption names a path that is not there.
  // Every fixture therefore carries the two real ones, so the guard is exercised rather than
  // routed around — and `REFUSE a stale exemption` below deletes one on purpose.
  mkdirSync(join(d, "scripts"), { recursive: true });
  writeFileSync(join(d, "rungs.json"), '{"seed":true}\n');
  writeFileSync(join(d, "scripts", "shared-census.json"), '{"seed":true}\n');
  execFileSync("git", ["-C", d, "add", "--", "rungs.json", "scripts/shared-census.json"], QUIET);
  return d;
}

function commit(d, files, message) {
  for (const [p, body] of Object.entries(files)) {
    if (body === null) {
      execFileSync("git", ["-C", d, "rm", "-q", "-f", p], QUIET);
      continue;
    }
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
    execFileSync("git", ["-C", d, "add", "--", p], QUIET);
  }
  execFileSync("git", ["-C", d, "commit", "-q", "--allow-empty", "-m", message], QUIET);
  return git(d, "rev-parse", "HEAD");
}

const blobAt = (d, ref, path) => {
  try {
    return git(d, "rev-parse", `${ref}:${path}`);
  } catch {
    return "ABSENT";
  }
};

/** A REJECT fixture that did not actually plant a revert would pass for the wrong reason. */
function mustRevert(d, head, ancestor, base, path, label) {
  const h = blobAt(d, head, path), a = blobAt(d, ancestor, path), b = blobAt(d, base, path);
  if (h !== a || h === b) {
    console.error(
      `FAIL  fixture "${label}" did not plant the shape it claims:\n` +
        `        head=${h.slice(0, 7)} ancestor=${a.slice(0, 7)} base=${b.slice(0, 7)}\n` +
        `      A REJECT case built on this would pass without the defect being present.`
    );
    process.exit(1);
  }
}

function run(d, ...args) {
  try {
    return { code: 0, out: execFileSync("node", [CHECKER, "--cwd", d, ...args], QUIET) };
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

/* ------------------------------------------------------------------ REJECT: the real thing */
{
  const SPECIMEN = "57cfa40a934f78447d4a39e9db0640ae747b66e0";
  const BUNDLE = join(ROOT, "scripts", "fixtures", "specimen-stale-tree-reverts-398.bundle");

  const tryResolve = () => {
    for (const ref of [
      SPECIMEN,
      "origin/specimen/stale-tree-reverts-398",
      "refs/specimens/377-stale-tree",
      "specimen/stale-tree-reverts-398",
    ]) {
      try { return git(ROOT, "rev-parse", "--verify", `${ref}^{commit}`); } catch { /* try next */ }
    }
    return null;
  };

  let resolved = tryResolve();

  /*
   * THE SPECIMEN TRAVELS WITH THE TREE, because relying on a remote branch did not survive
   * contact with CI (#427 went red on this exact line).
   *
   * `actions/checkout` with `fetch-depth: 0` gives the full HISTORY OF THE CHECKED-OUT REF. It
   * does not fetch other branches, so `specimen/stale-tree-reverts-398` exists on the remote
   * and NOT in the runner's clone — the checker refused (exit 2) rather than reporting a
   * verdict it could not compute, which is correct behaviour finding a missing environment.
   * Reproduced faithfully with `git clone --no-local --single-branch`: the specimen is
   * unresolvable there by sha AND by branch, exactly as in CI.
   *
   * A 9.7 KB bundle committed to the repo removes the question instead of answering it. It
   * needs no network, no extra CI step, and no belief about which refs a runner action fetches
   * — and it works IN A FORK, which closes the gap this case used to declare. The bundle's one
   * prerequisite is e02c008, a commit on main, which `fetch-depth: 0` guarantees is present.
   */
  if (!resolved && existsSync(BUNDLE)) {
    try {
      git(ROOT, "fetch", "--quiet", BUNDLE, "refs/specimens/*:refs/specimens/*");
      resolved = tryResolve();
      if (resolved) console.log(`  note    imported the specimen from ${BUNDLE.replace(ROOT + "/", "")}`);
    } catch (e) {
      console.error(`  note    bundle import failed: ${String(e.message).split("\n")[0]}`);
    }
  }
  if (!resolved) {
    // NOT a skip. The one case that proves this checker against a real defect cannot go
    // quietly absent — that is exactly how a proof becomes decorative while still printing
    // a row. Same reasoning as assert-overrides-cannot-go-inert refusing an empty override
    // set: a repo that genuinely does not have the subject should have to say so on purpose.
    console.error(
      `  FAIL    REJECT  the preserved specimen ${SPECIMEN.slice(0, 7)} is not in this clone.\n` +
        `          Fetch it:   git fetch origin specimen/stale-tree-reverts-398\n` +
        `          A shallow checkout will not have it; the job needs fetch-depth: 0.\n` +
        `\n` +
        `          The bundle at scripts/fixtures/ should have made this impossible — if it\n` +
        `          is missing or its prerequisite e02c008 is absent (a SHALLOW clone), fix that\n` +
        `          rather than this case. Only if the fork has rewritten main's history is the\n` +
        `          specimen genuinely unreachable. Then delete this case deliberately and\n` +
        `          drop EXPECTED to ${13}, rather than leaving it to fail on every run — but\n` +
        `          note what that costs: the checker is then proved only against constructed\n` +
        `          repositories, and a prescribed defect can be a no-op in a way a real one\n` +
        `          cannot. The other 13 cases still hold; this is the one that made them mean\n` +
        `          something. The checker itself remains useful in a fork, on the fork's own\n` +
        `          history.`
    );
    fail++;
  } else if (resolved !== SPECIMEN) {
    // The ref moved. Testing whatever it points at now would be testing a different subject
    // while reporting the specimen's name.
    console.error(
      `  FAIL    REJECT  the specimen ref resolves to ${resolved.slice(0, 7)}, not ` +
        `${SPECIMEN.slice(0, 7)}.\n` +
        `          The preserved defect has moved or been rewritten; this case would be ` +
        `measuring\n          a different commit under the specimen's name.`
    );
    fail++;
  } else {
    const base = git(ROOT, "rev-parse", `${resolved}^`);
    const r = run(ROOT, "--base", base, "--head", resolved);
    check(
      "REJECT  the preserved specimen: 7 files undoing 3 merged commits, gates all green",
      r.code === 1 &&
        /7 file\(s\)/.test(r.out) &&
        /undo 3 merged commit\(s\)/.test(r.out) &&
        /apps\/open-swe\/lib\/frameworks\.test\.ts/.test(r.out) &&
        /e2e\/shared\/llm\.spec\.ts/.test(r.out),
      `exit=${r.code}`,
      r.out
    );
  }
}

/* ------------------------------------------------------- REJECT: constructed, real git repo */
{
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2 — the merged fix\n" }, "fix the thing");
  const c = commit(d, { "src/app.ts": "v1\n", "src/new.ts": "new work\n" }, "unrelated feature");
  mustRevert(d, c, a, b, "src/app.ts", "plain stale-tree revert");
  const r = run(d, "--base", b, "--head", c);
  check(
    "REJECT  a file byte-identical to a pre-base state, with real new work alongside",
    r.code === 1 && /src\/app\.ts/.test(r.out) && !/src\/new\.ts/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

/* ------------------------------------------------------------ ACCEPT: deliberate, declared */
{
  const d = newRepo();
  commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2\n" }, "change it");
  execFileSync("git", ["-C", d, "revert", "--no-edit", b], QUIET);
  const head = git(d, "rev-parse", "HEAD");
  const r = run(d, "--base", b, "--head", head);
  check(
    "ACCEPT  `git revert` declares itself — its own message names the commit",
    r.code === 0 && /declared revert of/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2\n" }, "change it");
  const c = commit(d, { "src/app.ts": "v1\n" }, `undo that\n\nRevert-Of: ${b}\n`);
  mustRevert(d, c, a, b, "src/app.ts", "hand revert with trailer");
  const r = run(d, "--base", b, "--head", c);
  check(
    "ACCEPT  a hand-written revert declared with a Revert-Of: trailer",
    r.code === 0 && /declared revert of/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  // Abbreviated shas are what people actually paste.
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2\n" }, "change it");
  const c = commit(d, { "src/app.ts": "v1\n" }, `undo that\n\nRevert-Of: ${b.slice(0, 8)}\n`);
  mustRevert(d, c, a, b, "src/app.ts", "abbreviated trailer");
  const r = run(d, "--base", b, "--head", c);
  check("ACCEPT  an abbreviated sha in the trailer still matches", r.code === 0, `exit=${r.code}`, r.out);
}

/* ---------------------------------------- REJECT: the false ACCEPTs that would invert this */
{
  /*
   * THE ONE THAT MATTERS. Verbatim from the specimen's own commit message. A `/revert/i`
   * matcher accepts this, and with it the specimen — the check would ship backwards.
   */
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2\n" }, "change it");
  const c = commit(
    d,
    { "src/app.ts": "v1\n" },
    "test(runtime): both surfaces read a runtime from one declared set of cases\n\n" +
      "So example could be reverted to the exact pre-#360 behaviour with a green\n" +
      "suite. A fixture of happy-path rows would not have changed that.\n"
  );
  mustRevert(d, c, a, b, "src/app.ts", "prose about reverting");
  const r = run(d, "--base", b, "--head", c);
  check(
    "REJECT  prose ABOUT reverting is not a declaration (the specimen's own sentence)",
    r.code === 1,
    `exit=${r.code} — a substring matcher on "revert" would accept the specimen itself`,
    r.out
  );
}
{
  const d = newRepo();
  const a = commit(d, { "a.ts": "v1\n", "b.ts": "w1\n" }, "seed");
  const b1 = commit(d, { "a.ts": "v2\n" }, "change a");
  const b2 = commit(d, { "b.ts": "w2\n" }, "change b");
  const c = commit(d, { "a.ts": "v1\n", "b.ts": "w1\n" }, `undo a only\n\nRevert-Of: ${b1}\n`);
  mustRevert(d, c, a, b2, "b.ts", "undeclared second revert");
  const r = run(d, "--base", b2, "--head", c);
  check(
    "REJECT  declaring one revert does not license reverting a DIFFERENT commit",
    r.code === 1 && /b\.ts/.test(r.out) && !/^\s+a\.ts/m.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

/* ----------------------------------------------------------- ACCEPT: legitimate, not reverts */
{
  const d = newRepo();
  commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2\n" }, "change it");
  const c = commit(d, { "src/app.ts": "v3 — genuinely new\n" }, "move forward");
  const r = run(d, "--base", b, "--head", c);
  check("ACCEPT  ordinary forward work is not a revert", r.code === 0, `exit=${r.code}`, r.out);
}
{
  // Measured on real history: deleting a file always matches the state before it was added, so
  // 29/29 firings in an 80-commit sweep were legitimate removals. Deletions are counted, never
  // failed — and the count must be VISIBLE, or the gap is hidden rather than declared.
  const d = newRepo();
  commit(d, { "src/gone.ts": "x\n" }, "add a file");
  const b = commit(d, { "src/other.ts": "y\n" }, "add another");
  const c = commit(d, { "src/gone.ts": null }, "remove the first file");
  const r = run(d, "--base", b, "--head", c);
  check(
    "ACCEPT  a plain deletion does not fail, and the skipped count is reported",
    r.code === 0 && /1 deletion\(s\) not classified/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  /*
   * A DERIVED ARTIFACT RETURNING TO AN EARLIER VALUE. Measured twice on real history:
   * `3a1221a` and `496f9cc` each restore an earlier `rungs.json` because ownedFileCount went
   * up and came back down. Both go RED without this exemption — verified by disabling it.
   */
  const d = newRepo();
  const a = commit(d, { "rungs.json": '{"ownedFileCount":10}\n' }, "seed count");
  const b = commit(d, { "rungs.json": '{"ownedFileCount":11}\n' }, "a file was added");
  const c = commit(d, { "rungs.json": '{"ownedFileCount":10}\n' }, "that file went away again");
  mustRevert(d, c, a, b, "rungs.json", "derived artifact oscillation");
  const r = run(d, "--base", b, "--head", c);
  check(
    "ACCEPT  a derived artifact returning to an earlier value (pnpm rungs owns its freshness)",
    r.code === 0 && /1 derived artifact\(s\) exempt/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

/* -------------------------------------------------------------------------------- REFUSALS */
{
  /*
   * THE VACUITY THAT WOULD HAVE SHIPPED. ci.yml checks out at the default fetch-depth: 1. With
   * one commit of history every file's past is empty, nothing is ever found, and the check
   * exits 0 having compared against nothing.
   */
  const src = newRepo();
  commit(src, { "src/app.ts": "v1\n" }, "add app");
  commit(src, { "src/app.ts": "v2\n" }, "change it");
  commit(src, { "src/app.ts": "v3\n" }, "change again");
  const shallow = mkdtempSync(join(tmpdir(), "undeclared-reverts-shallow-"));
  dirs.push(shallow);
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, shallow], QUIET);
  const r = run(shallow, "--base", "HEAD", "--head", "HEAD");
  check(
    "REFUSE  a SHALLOW clone exits 2 — it would otherwise find nothing and call that a pass",
    r.code === 2 && /SHALLOW/.test(r.out) && /fetch-depth: 0/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  const d = newRepo();
  const b = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const c = commit(d, {}, "an empty commit");
  const r = run(d, "--base", b, "--head", c);
  check(
    "REFUSE  zero files compared exits 2 rather than passing over an empty diff",
    r.code === 2 && /changes no files/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  const d = newRepo();
  commit(d, { "src/app.ts": "v1\n" }, "add app");
  const r = run(d, "--base", "no/such/ref");
  check("REFUSE  an unresolvable base exits 2", r.code === 2 && /could not resolve base/.test(r.out), `exit=${r.code}`, r.out);
}
{
  // An exemption naming a path that is gone silently stops exempting anything, and the ACCEPT
  // behaviour proved above is no longer the behaviour shipping.
  const d = newRepo();
  commit(d, { "src/app.ts": "v1\n" }, "seed");
  const b = commit(d, { "rungs.json": null }, "remove the derived artifact");
  const c = commit(d, { "src/app.ts": "v2\n" }, "later work");
  const r = run(d, "--base", b, "--head", c);
  check(
    "REFUSE  a derived-artifact exemption that has gone stale exits 2",
    r.code === 2 && /exemption is stale/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

const EXPECTED = 14;
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
  `\nPASS: ${pass}/${total}. Watched it FIRE on the preserved specimen — seven files undoing three\n` +
    `      merged commits — and watched it stay quiet for a declared revert, an abbreviated\n` +
    `      trailer, forward work, a deletion, and a derived artifact returning to an old value.\n` +
    `      Watched it REFUSE a shallow clone, an empty diff, an unresolvable base and a stale\n` +
    `      exemption, rather than report a verdict it never computed.`
);
