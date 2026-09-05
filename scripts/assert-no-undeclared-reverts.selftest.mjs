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
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
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
  execFileSync(
    "git",
    ["-C", d, "config", "user.email", "probe@example.invalid"],
    QUIET
  );
  execFileSync("git", ["-C", d, "config", "user.name", "probe"], QUIET);
  execFileSync("git", ["-C", d, "config", "commit.gpgsign", "false"], QUIET);
  // The checker refuses when its derived-artifact exemption names a path that is not there.
  // Every fixture therefore carries the two real ones, so the guard is exercised rather than
  // routed around — and `REFUSE a stale exemption` below deletes one on purpose.
  mkdirSync(join(d, "scripts"), { recursive: true });
  writeFileSync(join(d, "rungs.json"), '{"seed":true}\n');
  writeFileSync(join(d, "scripts", "shared-census.json"), '{"seed":true}\n');
  execFileSync(
    "git",
    ["-C", d, "add", "--", "rungs.json", "scripts/shared-census.json"],
    QUIET
  );
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
  execFileSync(
    "git",
    ["-C", d, "commit", "-q", "--allow-empty", "-m", message],
    QUIET
  );
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
  const h = blobAt(d, head, path),
    a = blobAt(d, ancestor, path),
    b = blobAt(d, base, path);
  if (h !== a || h === b) {
    console.error(
      `FAIL  fixture "${label}" did not plant the shape it claims:\n` +
        `        head=${h.slice(0, 7)} ancestor=${a.slice(0, 7)} base=${b.slice(
          0,
          7
        )}\n` +
        `      A REJECT case built on this would pass without the defect being present.`
    );
    process.exit(1);
  }
}

function run(d, ...args) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--cwd", d, ...args], QUIET),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let pass = 0,
  fail = 0;
const check = (name, ok, detail, out) => {
  if (ok) {
    console.log(`  ok      ${name}`);
    pass++;
  } else {
    console.error(`  FAIL    ${name}  ${detail}`);
    console.error(
      String(out)
        .split("\n")
        .map((l) => `          | ${l}`)
        .join("\n")
    );
    fail++;
  }
};

/* ------------------------------------------------------------------ REJECT: the real thing */
{
  const SPECIMEN = "57cfa40a934f78447d4a39e9db0640ae747b66e0";
  const BUNDLE = join(
    ROOT,
    "scripts",
    "fixtures",
    "specimen-stale-tree-reverts-398.bundle"
  );

  const tryResolve = () => {
    for (const ref of [
      SPECIMEN,
      "origin/specimen/stale-tree-reverts-398",
      "refs/specimens/377-stale-tree",
      "specimen/stale-tree-reverts-398",
    ]) {
      try {
        return git(ROOT, "rev-parse", "--verify", `${ref}^{commit}`);
      } catch {
        /* try next */
      }
    }
    return null;
  };

  let resolved = tryResolve();

  /*
   * THE BUNDLE IS A FALLBACK, AND THE REASON ORIGINALLY WRITTEN HERE WAS WRONG. This said that
   * `fetch-depth: 0` "does not fetch other branches", so the specimen stayed on the remote and
   * CI refused. Its own run log contradicts that: run 33337957786 line 807 reads
   * `* [new branch] specimen/stale-tree-reverts-398 -> origin/specimen/stale-tree-reverts-398`,
   * and neither `note imported the specimen` nor `note bundle import failed` appears anywhere
   * in it (grep count 0 for both, against a positive control that counted 1). THE BUNDLE WAS
   * NEVER READ. What CI was actually refusing on is #427: an empty `$GIT_DIR/shallow` reporting
   * the clone as shallow while cutting nothing — fixed in the checker, not here.
   *
   * The bundle stays because it is genuinely useful where the branch is absent — a
   * single-branch clone, or a fork that copied main and not the specimen ref. Its one
   * prerequisite is e02c008, a commit on main. Its integrity is asserted below; the FETCH path
   * is not exercised by any case here, because this repo always resolves the sha directly, and
   * that is stated rather than left to look tested.
   */
  if (!resolved && existsSync(BUNDLE)) {
    try {
      git(
        ROOT,
        "fetch",
        "--quiet",
        BUNDLE,
        "refs/specimens/*:refs/specimens/*"
      );
      resolved = tryResolve();
      if (resolved)
        console.log(
          `  note    imported the specimen from ${BUNDLE.replace(
            ROOT + "/",
            ""
          )}`
        );
    } catch (e) {
      console.error(
        `  note    bundle import failed: ${String(e.message).split("\n")[0]}`
      );
    }
  }
  if (!resolved) {
    // NOT a skip. The one case that proves this checker against a real defect cannot go
    // quietly absent — that is exactly how a proof becomes decorative while still printing
    // a row. Same reasoning as assert-overrides-cannot-go-inert refusing an empty override
    // set: a repo that genuinely does not have the subject should have to say so on purpose.
    console.error(
      `  FAIL    REJECT  the preserved specimen ${SPECIMEN.slice(
        0,
        7
      )} is not in this clone.\n` +
        `          Fetch it:   git fetch origin specimen/stale-tree-reverts-398\n` +
        `          A shallow checkout will not have it; the job needs fetch-depth: 0.\n` +
        `\n` +
        `          The bundle at scripts/fixtures/ should have made this impossible — if it\n` +
        `          is missing or its prerequisite e02c008 is absent, fix that rather than this\n` +
        `          case. Only if the fork has rewritten main's history is the specimen\n` +
        `          genuinely unreachable. Then delete this case deliberately and drop EXPECTED\n` +
        `          by one, rather than leaving it to fail on every run.\n` +
        `\n` +
        `          What that costs is now SMALLER than it was, and the reason is worth knowing:\n` +
        `          two further REAL instances live on main itself (#409 reverting #396, and\n` +
        `          #426 declaring the revert of #409), so deleting this case does not drop the\n` +
        `          checker back to constructed repositories only. It does lose the STRONGEST\n` +
        `          shape — seven files undoing three commits, the stale-tree fingerprint — for\n` +
        `          which the others substitute one file undoing one.`
    );
    fail++;
  } else if (resolved !== SPECIMEN) {
    // The ref moved. Testing whatever it points at now would be testing a different subject
    // while reporting the specimen's name.
    console.error(
      `  FAIL    REJECT  the specimen ref resolves to ${resolved.slice(
        0,
        7
      )}, not ` +
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

/* ------------------------------ REJECT and ACCEPT: two more real instances, both on main */
/*
 * THE SPECIMEN IS NO LONGER THE ONLY REAL DEFECT AVAILABLE, and these two cost nothing to
 * carry: they are commits on main, present in any clone that has main, needing no preserved
 * branch and no bundle.
 *
 * `0cc6827` (#409) merged a stale copy of `apps/open-swe/lib/frameworks.test.ts` and silently
 * put back the pre-#396 blob — the same class as the specimen at one-file scale, found by DEV8
 * while building this very checker. `e4f8c9b` (#426) restored it and DECLARED the revert with a
 * `Revert-Of:` trailer. So the pair exercises REJECT and ACCEPT against real commits, and the
 * ACCEPT is a declaration someone actually wrote rather than one composed to pass.
 *
 * A REAL INSTANCE CANNOT BE A NO-OP THE WAY A PRESCRIBED MUTATION CAN. That is the whole
 * argument for the specimen, and it applies here twice more.
 */
{
  const cases = [
    {
      sha: "0cc68271ff384f3f60bfef3b6dbbc98f5c2de188",
      name: "REJECT  a real merged commit (#409) that put back the pre-#396 blob, undeclared",
      want: 1,
      expect: /apps\/open-swe\/lib\/frameworks\.test\.ts/,
      also: /undoes 9b3a4a0/,
    },
    {
      sha: "e4f8c9b2956b9f5f6dbf147b9c279649c457905a",
      name: "ACCEPT  the real revert of it (#426), declared with a Revert-Of: trailer someone wrote",
      want: 0,
      expect: /declared revert of 0cc6827/,
      also: /apps\/open-swe\/lib\/frameworks\.test\.ts/,
    },
  ];
  for (const c of cases) {
    let resolved = null;
    try {
      resolved = git(ROOT, "rev-parse", "--verify", `${c.sha}^{commit}`);
    } catch {
      /* reported below */
    }
    if (resolved !== c.sha) {
      // NOT a skip, for the same reason the specimen is not: a real instance that quietly goes
      // absent leaves a row printed and nothing proved.
      console.error(
        `  FAIL    ${c.name}\n` +
          `          ${c.sha.slice(0, 7)} is not in this clone (resolved: ${
            resolved ?? "nothing"
          }).\n` +
          `          It is a commit on main. If main's history has been rewritten under you,\n` +
          `          re-point this case at the rewritten sha or delete it deliberately — do not\n` +
          `          leave it failing on every run.`
      );
      fail++;
      continue;
    }
    const r = run(ROOT, "--base", `${c.sha}^`, "--head", c.sha);
    check(
      c.name,
      r.code === c.want && c.expect.test(r.out) && c.also.test(r.out),
      `exit=${r.code}`,
      r.out
    );
  }
}

/* --------------------------------------------- the bundle is a usable fixture, or it is not */
{
  /*
   * The bundle's FETCH path is not exercised (see above — this repo resolves the sha directly),
   * so this asserts the artifact instead of the code that would read it. It fires if the bundle
   * is truncated, re-pointed at a different commit, or built without the prerequisite that
   * makes it importable. That is not the same as proving the import works, and it is not
   * claimed to be.
   */
  const BUNDLE = join(
    ROOT,
    "scripts",
    "fixtures",
    "specimen-stale-tree-reverts-398.bundle"
  );
  let heads = "",
    verify = "";
  try {
    heads = git(ROOT, "bundle", "list-heads", BUNDLE);
    verify = execFileSync("git", ["-C", ROOT, "bundle", "verify", BUNDLE], {
      ...QUIET,
      maxBuffer: 1 << 26,
    }).toString();
  } catch (e) {
    heads = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  check(
    "the specimen bundle still contains the specimen, and names its prerequisite",
    /57cfa40a934f78447d4a39e9db0640ae747b66e0\s+refs\/specimens\/377-stale-tree/.test(
      heads
    ) && /e02c008374275c6ee815f39bb529c8dc9f4a7d22/.test(verify),
    "the fixture no longer holds what this file says it holds",
    `${heads}\n${verify}`
  );
}

/* ------------------------------------------------------- REJECT: constructed, real git repo */
{
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(
    d,
    { "src/app.ts": "v2 — the merged fix\n" },
    "fix the thing"
  );
  const c = commit(
    d,
    { "src/app.ts": "v1\n", "src/new.ts": "new work\n" },
    "unrelated feature"
  );
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
  const c = commit(
    d,
    { "src/app.ts": "v1\n" },
    `undo that\n\nRevert-Of: ${b}\n`
  );
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
  const c = commit(
    d,
    { "src/app.ts": "v1\n" },
    `undo that\n\nRevert-Of: ${b.slice(0, 8)}\n`
  );
  mustRevert(d, c, a, b, "src/app.ts", "abbreviated trailer");
  const r = run(d, "--base", b, "--head", c);
  check(
    "ACCEPT  an abbreviated sha in the trailer still matches",
    r.code === 0,
    `exit=${r.code}`,
    r.out
  );
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
  const c = commit(
    d,
    { "a.ts": "v1\n", "b.ts": "w1\n" },
    `undo a only\n\nRevert-Of: ${b1}\n`
  );
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
  check(
    "ACCEPT  ordinary forward work is not a revert",
    r.code === 0,
    `exit=${r.code}`,
    r.out
  );
}
{
  // Measured on real history: deleting a file always matches the state before it was added, so
  // 29/29 firings in an 80-commit sweep were legitimate removals. Deletions are counted, never
  // failed — and the count must be VISIBLE, or the gap is hidden rather than declared.
  const d = newRepo();
  commit(d, { "src/gone.ts": "x\n" }, "add a file");
  const b = commit(d, { "src/other.ts": "y\n" }, "add another");
  /*
   * THE COMMIT MOVES SOMETHING FORWARD AS WELL AS DELETING, and that is the change #507 made
   * to this case rather than an incidental edit. The rule it asserts is unchanged — A DELETION
   * IS NOT A VIOLATION — but a diff that is ONLY deletions is now a REFUSAL, because the check
   * examines nothing and its own output said so (`searched the history of 0`). That shape has
   * its own case below. Here the deletion sits beside real work, which is where the sweep's
   * 29/29 finding lives and where a pass still means something.
   */
  const c = commit(
    d,
    { "src/gone.ts": null, "src/other.ts": "y2\n" },
    "remove the first file, and move the other forward"
  );
  const r = run(d, "--base", b, "--head", c);
  check(
    "ACCEPT  a deletion beside real work does not fail, and the skipped count is reported",
    r.code === 0 && /1 deletion\(s\) not classified/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  /*
   * #507, AND THE SHAPE IS THE POINT. A stale tree deletes exactly the files its base gained
   * after the snapshot — so when that advance was ADDITIONS-ONLY, which is every PR that adds
   * a test or a script, the diff is deletions-only and the old check examined NOTHING and
   * called it a pass. Its own numbers said so: `compared 1 changed file(s); searched 0`.
   *
   * Measured before adopting the refusal: over the last 300 single-parent commits on main, 14
   * contain deletions and ZERO are deletions-only. Merged history is the RIGHT population for
   * that question — every commit in it is legitimate work — unlike the 29/29 sweep behind the
   * KNOWN GAP, which asked whether ILLEGITIMATE deletions occur of a population that by
   * construction contains none.
   */
  const src = newRepo();
  commit(src, { "app.ts": "v1\n" }, "seed");
  const b = commit(
    src,
    { "new-test.ts": "the evidence of the loss\n" },
    "base ADDS a test"
  );
  const c = commit(
    src,
    { "new-test.ts": null },
    "stale tree: the added file simply is not here"
  );
  const r = run(src, "--base", b, "--head", c);
  check(
    "REFUSE  a diff that is ONLY deletions — the check examined nothing and must not call it a pass (#507)",
    r.code === 2 &&
      /examined NOTHING/.test(r.out) &&
      /new-test\.ts/.test(r.out),
    `exit=${r.code}`,
    r.out
  );

  /*
   * ...and the refusal is DISCHARGEABLE the same way a revert is, or it is just a wall.
   * A SECOND REPOSITORY, because the deletion above already happened in the first one and a
   * successor commit cannot delete the same path twice — a fixture that threw while building
   * would have failed this case for a reason unconnected to the rule.
   */
  const src2 = newRepo();
  commit(src2, { "app.ts": "v1\n" }, "seed");
  const b2 = commit(
    src2,
    { "new-test.ts": "the evidence of the loss\n" },
    "base ADDS a test"
  );
  const declared = commit(
    src2,
    { "new-test.ts": null },
    `chore: remove it on purpose\n\nRevert-Of: ${b2}\n`
  );
  const r2 = run(src2, "--base", b2, "--head", declared);
  check(
    "ACCEPT  ...and saying so discharges it — a deliberate removal is not blocked",
    r2.code === 0,
    `exit=${r2.code}`,
    r2.out
  );
}
{
  /*
   * ATTRIBUTION, NOT DETECTION. A deletion is still never a failure on its own. But once THIS
   * RUN has proved the branch carries a stale tree, a file deleted here that was ADDED by one
   * of the commits being undone is part of the same loss — and naming it can only happen
   * inside a report that is already failing, so it costs no false positive.
   *
   * The live instance is why: a stale tree undid three files of #489 and DELETED that PR's
   * 113-line test outright. The three were named; the deletion was not.
   */
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(
    d,
    { "src/app.ts": "v2\n", "src/added-with-it.ts": "t\n" },
    "the merged fix, with its test"
  );
  const c = commit(
    d,
    { "src/app.ts": "v1\n", "src/added-with-it.ts": null },
    "stale tree"
  );
  mustRevert(d, c, a, b, "src/app.ts", "attribution");
  const r = run(d, "--base", b, "--head", c);
  check(
    "REJECT  a failing report NAMES the deletion that belongs to the commit it is undoing (#507)",
    r.code === 1 &&
      /added-with-it\.ts {2}\(DELETED — added by this commit\)/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  /*
   * THE RESIDUAL, PINNED SO IT CANNOT CHANGE IN SILENCE. A stale tree that also carries its
   * OWN new work has `searched > 0`, so the refusal above does not fire, and its deletions are
   * still unclassified. CONTENT CANNOT DECIDE THIS ONE: a tree that never had the file and a
   * tree that deliberately removed it are byte-identical, and nothing in the commit records
   * which snapshot it was built from.
   *
   * This case asserts the CURRENT behaviour so that closing the gap is a deliberate act with a
   * failing test to update, rather than something discovered later. It is a known gap with a
   * witness, not a claim that the gap is acceptable.
   */
  const d = newRepo();
  commit(d, { "app.ts": "v1\n" }, "seed");
  const b = commit(d, { "new-test.ts": "evidence\n" }, "base ADDS a test");
  const c = commit(
    d,
    { "new-test.ts": null, "mine.ts": "my own work\n" },
    "stale tree carrying real work"
  );
  const r = run(d, "--base", b, "--head", c);
  check(
    "KNOWN GAP  a stale tree with its own new work still passes — declared, not fixed (#507)",
    r.code === 0 && /1 deletion\(s\) not classified/.test(r.out),
    `exit=${r.code} — if this now FAILS the gap was closed; update this case deliberately`,
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
  const a = commit(
    d,
    { "rungs.json": '{"ownedFileCount":10}\n' },
    "seed count"
  );
  const b = commit(
    d,
    { "rungs.json": '{"ownedFileCount":11}\n' },
    "a file was added"
  );
  const c = commit(
    d,
    { "rungs.json": '{"ownedFileCount":10}\n' },
    "that file went away again"
  );
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
/*
 * TRUNCATION IS A PROPERTY OF THE CLONE **AND THE FILE**, AND THESE THREE CASES ARE WHY THE
 * GUARD NO LONGER READS `--is-shallow-repository` (#427).
 *
 * ONE repository, TWO clone depths, SAME base and head. The flag calls both of them shallow —
 * it has one bit and the question is per file. At depth 2 the base IS the boundary, `g.ts`
 * reads as "added there", the revert of it is invisible, and an unguarded check would exit 0
 * over a past it never saw. At depth 4 the commit that added `g.ts` is inside the clone, the
 * file's past is genuinely complete, and the SAME check FIRES on the SAME revert.
 *
 * The third case is the bug itself: an EMPTY shallow file. git reports the repository as
 * shallow the moment that file OPENS, so an empty one claims truncation while cutting nothing.
 * That is the state CI was in, and the old guard refused on it — red on a clone that had every
 * commit it needed.
 */
{
  // c1 seed · c2 filler · c3 ADDS g.ts · c4 changes it · c5 quietly puts it back (undeclared).
  const src = newRepo();
  commit(src, { "seed.md": "s\n" }, "seed");
  commit(src, { "filler.ts": "f\n" }, "filler");
  commit(src, { "g.ts": "w1\n" }, "add g");
  commit(src, { "g.ts": "w2\n" }, "change g");
  commit(src, { "g.ts": "w1\n" }, "quietly put g back");

  const cloneAt = (depth) => {
    const dst = mkdtempSync(
      join(tmpdir(), `undeclared-reverts-depth${depth}-`)
    );
    dirs.push(dst);
    execFileSync(
      "git",
      ["clone", "-q", "--depth", String(depth), `file://${src}`, dst],
      QUIET
    );
    return dst;
  };

  const tooShallow = cloneAt(2);
  const deepEnough = cloneAt(4);

  /*
   * THE COMPANION THAT MAKES THE PAIR MEAN SOMETHING. If the flag distinguished these two, the
   * next two cases would be about clone depth in general rather than about this file's past,
   * and re-pointing the guard would have bought nothing. It does not: both say "true".
   */
  const flags = [tooShallow, deepEnough].map((d) =>
    git(d, "rev-parse", "--is-shallow-repository")
  );
  check(
    "the FLAG cannot tell these two clones apart — both report shallow (so it is not the question)",
    flags.every((f) => f === "true"),
    `flags=${JSON.stringify(
      flags
    )} — if either is false the next two cases prove nothing about the flag`,
    flags.join(" ")
  );

  const cut = run(tooShallow, "--base", "HEAD~1", "--head", "HEAD");
  check(
    "REFUSE  a file whose past is CUT at the boundary — it reads as added there, hiding the revert",
    cut.code === 2 &&
      /cannot be read back to the commit that added them/.test(cut.out) &&
      /g\.ts/.test(cut.out) &&
      /fetch-depth: 0/.test(cut.out),
    `exit=${cut.code}`,
    cut.out
  );

  const deep = run(deepEnough, "--base", "HEAD~1", "--head", "HEAD");
  check(
    "...and in a clone deep enough for THAT file, the same check RUNS and FIRES on the same revert",
    deep.code === 1 && /g\.ts/.test(deep.out),
    `exit=${deep.code} — refusing here would be the flag's answer, not the file's`,
    deep.out
  );
}
{
  /*
   * #427 ITSELF, PINNED. A complete repository with an empty `$GIT_DIR/shallow`: the flag says
   * shallow, nothing is cut, and the check must give its verdict rather than refuse.
   */
  const d = newRepo();
  const a = commit(d, { "src/app.ts": "v1\n" }, "add app");
  const b = commit(d, { "src/app.ts": "v2\n" }, "the merged fix");
  const c = commit(d, { "src/app.ts": "v1\n" }, "unrelated feature");
  mustRevert(d, c, a, b, "src/app.ts", "empty shallow file");
  writeFileSync(join(d, ".git", "shallow"), "");
  const flag = git(d, "rev-parse", "--is-shallow-repository");
  const r = run(d, "--base", b, "--head", c);
  check(
    "an EMPTY shallow file reports shallow while cutting NOTHING — the check must still answer (#427)",
    flag === "true" && r.code === 1 && /src\/app\.ts/.test(r.out),
    `flag=${flag} exit=${r.code} — the flag must be true here or this case is not the CI state`,
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
  check(
    "REFUSE  an unresolvable base exits 2",
    r.code === 2 && /could not resolve base/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
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

const EXPECTED = 24;
const total = pass + fail;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(`\nFAIL: ${fail}/${total}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Watched it FIRE on THREE REAL DEFECTS: the preserved specimen (seven\n` +
    `      files undoing three merged commits) and #409 on main, which put back a pre-#396 blob;\n` +
    `      and watched it stay quiet for #426's real Revert-Of: declaration, a \`git revert\`, an\n` +
    `      abbreviated trailer, forward work, a deletion, and a derived artifact returning to an\n` +
    `      old value.\n` +
    `      Watched it REFUSE an empty diff, an unresolvable base, a stale exemption, and a file\n` +
    `      whose past is CUT at a shallow boundary — while still ANSWERING in a clone the shallow\n` +
    `      flag calls truncated but which holds that file's whole history, and in a repository\n` +
    `      whose shallow file is empty. Both of those are cases the flag it used to read cannot\n` +
    `      distinguish, and the second one is what made CI red on this checker's own proof.`
);
