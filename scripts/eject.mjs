#!/usr/bin/env node
/**
 * eject.mjs — `pnpm eject <rung>`: delete every rung above <rung> and leave a COHERENT repo.
 *
 * Not "delete some files". The close condition is that the result is a repo someone could have
 * written by hand: it installs from its own lockfile, builds, tests, typechecks, and contains no
 * reference to a rung it does not have.
 *
 * FOUR STEPS. The fourth is the one people forget.
 *   1. DELETE   every path owned by a rung outside the retain set.
 *   2. REWRITE  rungs.json itself (the fork is an INPUT to this same tooling, not an artifact),
 *               plus barrels, playwright projects, and the generated types.
 *   3. PRUNE    the lockfile, so `pnpm install --frozen-lockfile` succeeds in the fork.
 *   4. PYTHON   by path, not by pnpm. Neither backend has a package.json, so despite the
 *               `apps/*` workspace glob pnpm cannot see them at all — they are absent from the
 *               lockfile while all four TS apps are present. Deleting ai_backends/<rung>.py and
 *               editing the two __init__.py registries and two _MODULES dicts is filesystem
 *               work no pnpm tooling reaches. A 5-job matrix would edit this plane and never
 *               execute it.
 *
 * EDITS ARE DERIVED, NOT LISTED. Which barrel exports to drop, which playwright projects to
 * remove, which testMatch entries to prune — all computed from the set of deleted files. A
 * hardcoded list of names would go stale the first time someone renames a file, and go stale
 * SILENTLY, which is the failure mode this whole issue exists to remove.
 *
 * REFUSES TO RUN ON A STALE MANIFEST. If classification is not total and disjoint, eject exits
 * before touching the tree: ejecting against an incomplete census is precisely how you get the
 * incoherent-but-green repo this is meant to prevent.
 *
 * Usage:  node scripts/eject.mjs <rung> [--dry-run] [--cwd DIR]
 */
import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const cwdFlag = argv.indexOf("--cwd");
const CWD = cwdFlag >= 0 ? resolve(argv[cwdFlag + 1]) : ROOT;
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !(cwdFlag >= 0 && i === cwdFlag + 1)
);
const target = positional[0];

const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  // Every exit path states a verdict on its last line, so `tail -1` can never disagree with the
  // run. Refusals before the mutating phase have changed nothing by construction, and say so.
  console.error(`\nRESULT: refused, nothing was changed.`);
  process.exit(1);
};
const log = (msg) => console.log(msg);

/** Verification failed on the produced tree — distinct from eject itself crashing. */
class EjectVerificationError extends Error {
  constructor(leaks) {
    super(`${leaks.length} dangling reference(s)`);
    this.leaks = leaks;
  }
}

if (!target) die("usage: eject.mjs <rung> [--dry-run] [--cwd DIR]");

const manifestPath = join(CWD, "rungs.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  // A corrupt or missing manifest crashed with a raw parser stack, which reads as a tool bug
  // rather than "your rungs.json is broken". Same lesson as the census gate: the guard fired,
  // but the message a maintainer needs was buried under a trace.
  die(`could not read ${manifestPath}:\n       ${e.message}`);
}
const byId = new Map(manifest.rungs.map((r) => [r.id, r]));
if (!byId.has(target)) {
  die(`unknown rung "${target}". Known: ${[...byId.keys()].join(", ")}`);
}

// --- Gate: the WORKING TREE must be clean, before a single unlink ---------------------------
//
// eject deletes 100+ tracked files. Without this gate a mid-run failure — a permission error, a
// full disk, a file someone removed by hand — leaves a tree that is neither the original nor a
// fork, with no way back. That happened: a run died on ENOENT having already deleted 134 files,
// and the NEXT run refused with "stale census" naming files the first run had destroyed. The
// guard correctly reported damage the tool itself had caused a minute earlier.
//
// "Just git checkout" is not an answer for our actual audience. A forker clones the reference
// implementation and runs the one command the whole thing is built around; they may not have
// committed anything, so there is nothing to check out.
//
// This gate is also what makes ROLLBACK possible below: with a clean tree, `git checkout -- .`
// plus `git clean -fd` restores exactly the original and can destroy nothing of the user's.
//
// It fixes a second confusion for free: a git-based classifier cannot see UNTRACKED files, so
// they are unclassified and get swept. Requiring a clean tree makes that impossible to hit by
// accident.
if (!DRY) {
  let porcelain = "";
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: CWD,
      encoding: "utf8",
    }).trim();
  } catch (e) {
    die(`could not read git status, so the tree's cleanliness is unknown:\n       ${e.message}`);
  }
  if (porcelain) {
    const lines = porcelain.split("\n");
    die(
      `working tree is not clean — refusing to eject.\n` +
        `       eject deletes tracked files and can only roll back from a clean tree.\n` +
        `       Untracked files are also invisible to the classifier and would be swept.\n\n` +
        lines.slice(0, 15).map((l) => `       ${l}`).join("\n") +
        (lines.length > 15 ? `\n       ...and ${lines.length - 15} more` : "") +
        `\n\n       Commit or stash your changes, then re-run.`
    );
  }
}

// --- Gate: the census must be clean before we touch anything --------------------------------
//
// classify.mjs EXITS NON-ZERO when the census is dirty, which is exactly the case this gate
// exists to catch — and execFileSync THROWS on non-zero exit. Not catching it meant the guard
// crashed with a raw Node stack instead of refusing cleanly: the refusal still happened, but it
// looked like a tool failure rather than a deliberate stop, and the message a maintainer needs
// ("your manifest is stale, here is how") was buried under a spawn error. Found by
// eject.selftest.mjs, which asserts the guard fires FOR THE STATED REASON, not merely that
// something went wrong. Asserting the reason is what caught this.
{
  let raw;
  try {
    raw = execFileSync(
      "node",
      [join(ROOT, "scripts", "classify.mjs"), "--json"],
      {
        cwd: CWD,
        encoding: "utf8",
        env: { ...process.env, RUNGS_CWD: CWD, RUNGS_MANIFEST: manifestPath },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (e) {
    raw = e.stdout ?? "";
    if (!raw.trim()) {
      die(
        `could not run the classifier, so the census is unknown:\n       ${
          e.stderr ?? e.message
        }`
      );
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(
      `classifier produced unparseable output, so the census is unknown:\n       ${raw.slice(
        0,
        400
      )}`
    );
  }
  if (!parsed.ok) {
    die(
      `classification is not clean — refusing to eject against a stale census.\n` +
        parsed.errors.map((e) => `       ${e}`).join("\n")
    );
  }
}

// --- The retain set: transitive closure of `requires`, downward ------------------------------
const retain = new Set();
(function visit(id) {
  if (retain.has(id)) return;
  retain.add(id);
  byId.get(id).requires.forEach(visit);
})(target);
const dropped = manifest.rungs.filter((r) => !retain.has(r.id));

log(`eject ${target}`);
log(
  `  retain : ${manifest.rungs
    .filter((r) => retain.has(r.id))
    .map((r) => r.id)
    .join(", ")}`
);
log(`  drop   : ${dropped.map((r) => r.id).join(", ") || "(nothing)"}`);
if (dropped.length === 0) {
  log("  nothing to do — already the top rung.");
  log(`\nRESULT: nothing to eject; "${target}" is already the top rung.`);
  process.exit(0);
}

// --- Which files die -------------------------------------------------------------------------
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else re += ".+";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: CWD,
  encoding: "utf8",
  maxBuffer: 64 << 20,
})
  .split("\0")
  .filter(Boolean);

const doomed = new Set();
for (const rung of dropped) {
  for (const globs of Object.values(rung.owns)) {
    if (!Array.isArray(globs)) continue;
    for (const g of globs) {
      const re = globToRegExp(g);
      for (const f of tracked) if (re.test(f)) doomed.add(f);
    }
  }
}

// The census says exactly how many files should die. An EXACT equality, not a floor: it cannot
// pass on a no-op (0 != 103) and cannot pass on over-deletion (112 != 103).
const expected = dropped.reduce((n, r) => n + (r.ownedFileCount ?? NaN), 0);
if (!Number.isFinite(expected)) {
  die(
    "a dropped rung has no frozen ownedFileCount — run: node scripts/classify.mjs --freeze"
  );
}
if (doomed.size !== expected) {
  die(
    `deletion set is ${doomed.size} files but the frozen census says ${expected}. ` +
      `The manifest and the tree disagree; refusing to guess which is right.`
  );
}
log(`  delete : ${doomed.size} files (census agrees)`);

if (DRY) {
  for (const f of [...doomed].sort()) log(`    - ${f}`);
  log(`\nRESULT: dry run only, nothing was written.`);
  process.exit(0);
}

// ============================================================================================
// PRE-FLIGHT — every path must be present and removable BEFORE anything is unlinked.
//
// Turns "died halfway through deleting 134 files" into a failure that has changed nothing. A
// tracked-but-missing path is the exact case that killed the run described above: git still
// lists it, the census counts it, and rmSync trips over it after the damage is done.
// ============================================================================================
{
  const problems = [];
  for (const f of doomed) {
    const abs = join(CWD, f);
    if (!existsSync(abs)) {
      problems.push(`${f} is tracked but missing from the working tree`);
      continue;
    }
    try {
      accessSync(dirname(abs), fsConstants.W_OK);
    } catch {
      problems.push(`${f} sits in a directory this process cannot write to`);
    }
  }
  if (problems.length > 0) {
    console.error(`FAIL: pre-flight found ${problems.length} path(s) eject could not remove.`);
    console.error(`      Nothing has been deleted.`);
    for (const p of problems.slice(0, 20)) console.error(`       ${p}`);
    if (problems.length > 20) console.error(`       ...and ${problems.length - 20} more`);
    console.error(`\nRESULT: refused, nothing was changed.`);
    process.exit(1);
  }
}

/**
 * Restore the tree to the commit it started from.
 *
 * Safe precisely BECAUSE of the clean-tree gate: there is nothing of the user's to lose, so a
 * hard restore cannot destroy work. `git clean -fd` (no -x) respects .gitignore, so node_modules
 * and build output survive.
 */
function rollback() {
  try {
    // `reset --hard`, not `checkout -- .`: deletions are STAGED now, so restoring the worktree
    // from the index would restore the deletion. The clean-tree gate guarantees HEAD == index ==
    // worktree on entry, so resetting to HEAD is exactly the state the caller started in.
    execFileSync("git", ["reset", "--hard", "--quiet", "HEAD"], { cwd: CWD, stdio: "ignore" });
    execFileSync("git", ["clean", "-fdq"], { cwd: CWD, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Everything below MUTATES. Any failure rolls the whole tree back, so eject either produces a
// coherent fork or leaves the original untouched — never a third thing.
try {

// ============================================================================================
// STEP 1 — delete
// ============================================================================================
// `git rm`, not rmSync. rmSync removes from DISK only; the git INDEX still lists every deleted
// path. classify.mjs reads the index (`git ls-files`) and has no existence filter, so it
// reported 26 C2 failures over files that were not there — a check delivering a verdict about a
// subject that does not exist, inside the tool built to find exactly that defect elsewhere.
//
// It hid well: rungs 4 and 5 delete 1 and 0 files, so their index barely diverges and CHECK-2
// passed. The 2-of-5 pass rate tracked DELETION VOLUME, not correctness.
//
// It also hid from ME: eject's own post-check filtered `git ls-files` through existsSync, which
// papered over the divergence in the one place that would have surfaced it. That filter is gone
// below, replaced by an assertion that index and worktree agree.
{
  const listFile = join(tmpdir(), `eject-doomed-${process.pid}`);
  writeFileSync(listFile, [...doomed].join("\0"));
  try {
    execFileSync(
      "git",
      ["rm", "-f", "--quiet", "--pathspec-from-file", listFile, "--pathspec-file-nul"],
      { cwd: CWD, stdio: ["ignore", "ignore", "pipe"] }
    );
  } finally {
    rmSync(listFile, { force: true });
  }
}
// Remove now-empty directories git would not track anyway.
try {
  execFileSync(
    "git",
    ["clean", "-fdq", "--", "apps", "packages", "docs", "e2e"],
    { cwd: CWD }
  );
} catch {
  /* best effort */
}

// ============================================================================================
// STEP 2 — rewrite what refers to what died
// ============================================================================================

/** Resolve a relative import specifier the way TS/node would. */
function resolveSpec(fromFile, spec) {
  // Bundler query/fragment suffixes (`./health.ts?raw`) are not part of the path.
  const clean = spec.split("?")[0].split("#")[0];
  const base = resolve(dirname(fromFile), clean);
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    base.replace(/\.js$/, ".ts"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Prune barrel re-exports whose target no longer exists.
 *
 * DERIVED from the deletion set, not from a list of symbol names: a hardcoded list goes stale
 * on the first rename, and goes stale silently.
 */
const doomedAbs = new Set([...doomed].map((f) => resolve(CWD, f)));
let prunedExports = 0;
for (const file of tracked) {
  if (doomed.has(file)) continue;
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const abs = join(CWD, file);
  const src = readFileSync(abs, "utf8");
  if (!/^\s*export\s.*\bfrom\s+["']\./m.test(src)) continue;
  const kept = src.split("\n").filter((line) => {
    const m = line.match(/^\s*export\s.*\bfrom\s+["'](\.[^"']*)["']/);
    if (!m) return true;
    // A specifier that no longer resolves, or resolves into the deletion set, must go.
    const resolved = resolveSpec(abs, m[1]);
    const wasDoomed =
      resolved === null ||
      doomedAbs.has(resolved) ||
      [...doomedAbs].some((d) => d === resolved);
    if (wasDoomed) prunedExports++;
    return !wasDoomed;
  });
  const out = kept.join("\n");
  if (out !== src) writeFileSync(abs, out);
}
log(`  barrels: pruned ${prunedExports} dangling re-export(s)`);

/**
 * Prune the PROTOCOL DECLARATIONS — the parts the fork claims it can speak.
 *
 * Deleting a rung removes its producer and its renderer. It did NOT remove the DECLARATION
 * that the part exists: a rung-1 fork shipped a SCHEMA_MAP of eleven entries and could
 * produce three, and published a JSON Schema accepting `data-plan` frames it can never emit.
 * `packages/react/src/schemas.ts` is not rung-owned — the `packages/react/**` shared glob
 * swallows it whole — so file-granularity severability structurally cannot reach this. The
 * file is shared; its CONTENTS are rung-specific. Ownership is recorded per FILE, and here it
 * has to be consumed per ENTRY.
 *
 * Not merely documentation: sse-frame-schema.test.ts compiles that file with Ajv and
 * validates real frames against it, and Ajv IGNORES unknown `x-` keywords. So `x-emitted-by`
 * has zero effect on validation, and #62's "a fork's schema is truthful without regeneration"
 * held for a reader and not for a validator. The artifact is both. Hence pruning, with the
 * annotation kept for readers and used as the key here.
 *
 * PRUNE BY ATTRIBUTION, NEVER BY ABSENCE OF A PRODUCER. `x-emitted-by` names the rung that
 * emits each frame: "core" survives every eject, and null marks a frame nothing in this
 * repository emits. `data-task` and `data-agents-md` are null and are RETAINED DELIBERATELY
 * (#50) — a consumer's own backend may emit that shape, and dropping the entry would silently
 * narrow a contract people already build against. "No producer in the retain set" is the
 * obvious rule and it deletes exactly those two, which is why attribution is the key.
 */
const FRAME_SCHEMA_REL = "docs/sse-frame-schema.json";
const SCHEMA_MAP_REL = "packages/react/src/schemas.ts";
const frameSchemaAbs = join(CWD, FRAME_SCHEMA_REL);
let prunedParts = 0;

if (existsSync(frameSchemaAbs)) {
  const droppedRungIds = new Set(dropped.map((r) => r.id));
  const doc = JSON.parse(readFileSync(frameSchemaAbs, "utf8"));
  const frames = Array.isArray(doc.oneOf) ? doc.oneOf : [];

  // A string naming a DROPPED rung, and nothing else. "core" and null both fail this by
  // construction rather than by being special-cased afterwards.
  const isDoomedFrame = (f) =>
    typeof f?.title === "string" &&
    f.title.startsWith("data-") &&
    typeof f["x-emitted-by"] === "string" &&
    droppedRungIds.has(f["x-emitted-by"]);

  const doomedParts = new Set(frames.filter(isDoomedFrame).map((f) => f.title));

  if (doomedParts.size > 0) {
    // The published contract. Non-ASCII is re-escaped because the checked-in file is written
    // that way; JSON.stringify emits literal em-dashes, which would rewrite five untouched
    // `description` strings and bury the real change in a fork's diff.
    doc.oneOf = frames.filter((f) => !isDoomedFrame(f));
    const asciiSafe = JSON.stringify(doc, null, 2).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
    writeFileSync(frameSchemaAbs, `${asciiSafe}\n`);

    // The runtime registry. One entry per line is what makes a line-wise prune safe; a
    // multi-entry line would silently keep its neighbours, and the agreement property in
    // packages/react/src/schema-map-agreement.test.ts is what would catch that.
    const mapAbs = join(CWD, SCHEMA_MAP_REL);
    if (existsSync(mapAbs)) {
      const before = readFileSync(mapAbs, "utf8");
      const after = before
        .split("\n")
        .filter((line) => {
          const m = line.match(/^\s*"(data-[a-z-]+)":\s*[A-Za-z0-9_]+,\s*$/);
          return !(m && doomedParts.has(m[1]));
        })
        .join("\n");
      if (after !== before) writeFileSync(mapAbs, after);
    }
    prunedParts = doomedParts.size;
  }
}
log(`  protocol: pruned ${prunedParts} data-* declaration(s)`);

/**
 * Prune playwright projects and testMatch entries that reference a deleted spec.
 *
 * Also derived. A project whose testMatch matches nothing does not fail — it contributes zero
 * tests and the run stays green, which is the same fail-open shape as a grep over a missing
 * file. So the project is removed rather than left to match nothing.
 */
const pwPath = join(CWD, "playwright.config.ts");
if (existsSync(pwPath)) {
  const deletedSpecNames = [...doomed]
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) =>
      f
        .split("/")
        .pop()
        .replace(/\.spec\.ts$/, "")
    );
  if (deletedSpecNames.length > 0) {
    let src = readFileSync(pwPath, "utf8");
    const before = src;
    // Drop whole project objects whose testMatch names a deleted spec.
    src = src.replace(
      /\n\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\},?(?=\n)/g,
      (block) => {
        const m = block.match(/testMatch:\s*(.+)/);
        if (!m) return block;
        const hit = deletedSpecNames.some((n) => m[1].includes(n));
        return hit && /name:\s*"/.test(block) ? "" : block;
      }
    );
    // Drop surviving testMatch ARRAY entries that name a deleted spec (e.g. mobile-chrome's
    // [/nextjs\.spec\.ts/, /deepagents-cards\.spec\.ts/]).
    src = src.replace(/testMatch:\s*\[([^\]]*)\]/g, (whole, inner) => {
      const kept = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((entry) => !deletedSpecNames.some((n) => entry.includes(n)));
      return kept.length ? `testMatch: [${kept.join(", ")}]` : "testMatch: []";
    });
    if (src !== before) {
      writeFileSync(pwPath, src);
      log(
        `  e2e    : pruned playwright projects/testMatch for ${deletedSpecNames.length} deleted spec(s)`
      );
    }
  }
}

// --- Rewrite the manifest. The fork must be a valid INPUT to this same tooling. --------------
const nextManifest = {
  ...manifest,
  rungs: manifest.rungs.filter((r) => retain.has(r.id)),
};
// Shared globs that no longer match anything would trip C4 in the fork.
nextManifest.shared = { ...manifest.shared };
writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + "\n");

// ============================================================================================
// STEP 4 — the Python plane, by path
// ============================================================================================
const droppedIds = dropped.map((r) => r.id);
const pyRegistries = [
  "apps/django-backend/deepagents_backend/ai_backends/__init__.py",
  "apps/fastapi-backend/ai_backends/__init__.py",
];
const pyDispatch = [
  "apps/django-backend/deepagents_backend/views.py",
  "apps/fastapi-backend/main.py",
];
let pyEdits = 0;
for (const rel of [...pyRegistries, ...pyDispatch]) {
  const abs = join(CWD, rel);
  if (!existsSync(abs)) continue;
  let src = readFileSync(abs, "utf8");
  const before = src;
  for (const id of droppedIds) {
    // `from . import _common, deepagents, langchain` / `from ai_backends import ...`
    src = src.replace(
      /^((?:from [.\w]+ )?import )([^\n]+)$/gm,
      (line, head, names) => {
        if (!/^[\w, ]+$/.test(names)) return line;
        const kept = names
          .split(",")
          .map((s) => s.trim())
          .filter((n) => n && n !== id);
        return kept.length ? `${head}${kept.join(", ")}` : "";
      }
    );
    // `__all__ = [...]`
    src = src.replace(/__all__\s*=\s*\[([^\]]*)\]/g, (whole, inner) => {
      const kept = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((q) => q.replace(/["']/g, "") !== id);
      return `__all__ = [${kept.join(", ")}]`;
    });
    // `_MODULES = { "deepagents": deepagents, ... }` — one entry per line in both backends.
    src = src.replace(
      new RegExp(`^\\s*"${id}"\\s*:\\s*${id}\\s*,\\s*$\\n`, "gm"),
      ""
    );
  }
  if (src !== before) {
    writeFileSync(abs, src);
    pyEdits++;
  }
}
log(`  python : edited ${pyEdits} registry/dispatch file(s)`);

// --- Regenerate the typed face of the manifest ------------------------------------------------
// RUNGS_CWD, not just cwd: the generator derives its paths from its own file location, so
// passing only `cwd` regenerated the SOURCE repo's generated.ts and left the fork's declaring
// the full ladder. Silent, and unfalsifiable — the subject it checked was always correct.
execFileSync("node", [join(ROOT, "scripts", "gen-rung-types.mjs")], {
  cwd: CWD,
  env: { ...process.env, RUNGS_CWD: CWD, RUNGS_MANIFEST: manifestPath },
  stdio: "ignore",
});

// ============================================================================================
// STEP 3 — prune the lockfile so the fork installs from its own
// ============================================================================================
try {
  execFileSync("pnpm", ["install", "--lockfile-only", "--silent"], {
    cwd: CWD,
    stdio: "ignore",
  });
  log("  lockfile: regenerated");
} catch {
  log(
    "  lockfile: pnpm unavailable — the fork's `pnpm install --frozen-lockfile` will catch it"
  );
}

// ============================================================================================
// POST-CHECK — nothing retained may still POINT AT something deleted.
//
// This started as a grep for the dropped rung's identifier and that was WRONG, in an
// instructive way. "deepagents" is not only a rung id here — it is the product namespace
// (@deepagents-nextjs/*), the Django project package (deepagents_backend), and a symbol
// (createDeepAgentsHandler). The grep reported 135 hits on a correct eject, essentially all of
// them the product rather than the rung. Same collision C7 hit with deepagents_backend.
//
// A check that cannot tell a true hit from a false one is a check somebody will disable, so the
// property was wrong, not the threshold. "No file mentions the word" was never what coherence
// means. What it means is: NOTHING STILL POINTS AT SOMETHING THAT IS GONE. That is decidable,
// so it is what is checked:
//
//   1. no retained TS file imports a relative path that no longer resolves;
//   2. no retained config references a deleted workspace app by path or --filter.
//
// The heavy lifting is still CHECK-3 in the matrix: the fork must install from its own
// lockfile, build, typecheck and test. A dangling import fails tsc loudly and without false
// positives. This check exists to fail EARLIER and with a better message, not to replace it.
// ============================================================================================
const surviving = execFileSync("git", ["ls-files", "-z"], {
  cwd: CWD,
  encoding: "utf8",
  maxBuffer: 64 << 20,
})
  .split("\0")
  .filter(Boolean);

// INVARIANT: the index and the worktree agree.
//
// Stronger than "classify passes", and it is the statement that was silently false. Previously
// this list was filtered through existsSync, which made every check below quietly skip the
// phantom paths instead of reporting them — the workaround that hid the divergence from its own
// author. Asserted, not filtered.
{
  const phantom = surviving.filter((f) => !existsSync(join(CWD, f)));
  if (phantom.length > 0) {
    throw new Error(
      `${phantom.length} path(s) are tracked in git but absent from disk — eject removed them ` +
        `without staging the deletion:\n` +
        phantom.slice(0, 10).map((f) => `       ${f}`).join("\n") +
        (phantom.length > 10 ? `\n       ...and ${phantom.length - 10} more` : "")
    );
  }
}

/**
 * Strip block and line comments, so PROSE about an import is not mistaken for an import.
 *
 * Both adapter-contract.ts and severability.test.ts document the coupling they removed, quoting
 * the old specifiers verbatim. Scanning raw text reported ARCHITECT's fix as a leak — a check
 * that flags the documentation of a fixed bug as the bug itself.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const leaks = [];

// 1. Dangling relative imports.
for (const f of surviving) {
  if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue;
  const abs = join(CWD, f);
  const src = stripComments(readFileSync(abs, "utf8"));
  for (const m of src.matchAll(/\bfrom\s+["'](\.[^"'\n]*)["']/g)) {
    if (resolveSpec(abs, m[1]) === null)
      leaks.push(`${f} imports "${m[1]}", which no longer exists`);
  }
}

// 3. WORKSPACE-BARREL SYMBOL IMPORTS — the class that actually breaks forks.
//
// Checks 1 and 2 cover dangling RELATIVE imports and config naming a deleted app. Neither sees
// `import { PlanCard } from "@deepagents-nextjs/react"` after PlanCard was pruned from that
// package's barrel — the specifier still resolves, the package still exists, only the SYMBOL is
// gone. That was 100% of apps/example's breakage, and it is why "eject succeeded, zero dangling
// references" and "example#build fails" were both true at once. The summary line was a proxy for
// coherence and did not mean it.
//
// This does not replace tsc. tsc is the real check and runs in the severability matrix; a
// regex cannot see re-export chains through a package's own dependencies, `export *`, or
// namespace access. What it does is catch the common, fork-breaking case HERE, loudly, instead
// of leaving eject to report a clean bill of health over a fork that cannot build.
{
  // workspace package name -> its barrel, so imports can be resolved to real exports.
  const workspaceBarrels = new Map();
  for (const f of surviving) {
    const m = f.match(/^packages\/([^/]+)\/package\.json$/);
    if (!m) continue;
    try {
      const name = JSON.parse(readFileSync(join(CWD, f), "utf8")).name;
      const barrel = join(CWD, "packages", m[1], "src", "index.ts");
      if (name && existsSync(barrel)) workspaceBarrels.set(name, barrel);
    } catch {
      /* unreadable package.json is not this check's business */
    }
  }

  /**
   * Every name a barrel exports — values AND types, since both break a static import.
   *
   * FOLLOWS `export * from "./x"` RECURSIVELY. packages/ui's barrel is 20 star re-exports, so a
   * parser that stopped at the top level reported 39 of its primitives as "no longer exported"
   * on a fork where nothing about them had changed. A check that cries wolf gets disabled, which
   * would have been worse than the blindness it replaced.
   *
   * Returns null when the truth cannot be established — a star re-export of a non-relative
   * specifier, or a file that will not read. Callers SKIP a null rather than guessing, because
   * the honest answer there is "tsc's job", not a false positive.
   */
  const exportsOf = (barrelPath, seen = new Set()) => {
    if (seen.has(barrelPath)) return new Set();
    seen.add(barrelPath);
    let src;
    try {
      src = stripComments(readFileSync(barrelPath, "utf8"));
    } catch {
      return null;
    }
    const names = new Set();
    for (const m of src.matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
    )) {
      names.add(m[1]);
    }
    for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
      for (const part of m[1].split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        names.add((t.includes(" as ") ? t.split(" as ")[1] : t).trim());
      }
    }
    for (const m of src.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["']/gm)) {
      if (!m[1].startsWith(".")) return null; // re-exports another package: cannot resolve here
      const target = resolveSpec(barrelPath, m[1]);
      if (target === null) return null;
      const inner = exportsOf(target, seen);
      if (inner === null) return null;
      for (const n of inner) names.add(n);
    }
    return names;
  };

  const barrelExports = new Map();
  for (const [name, path] of workspaceBarrels) {
    const ex = exportsOf(path);
    if (ex !== null) barrelExports.set(name, ex); // unresolvable barrels are left to tsc
  }

  for (const f of surviving) {
    if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue;
    const src = stripComments(readFileSync(join(CWD, f), "utf8"));
    for (const m of src.matchAll(
      /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
    )) {
      const exported = barrelExports.get(m[2]);
      if (!exported) continue; // not a workspace package we can resolve — tsc's problem, not ours
      for (const part of m[1].split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        const imported = (t.includes(" as ") ? t.split(" as ")[0] : t).trim();
        if (!imported || exported.has(imported)) continue;
        leaks.push(`${f} imports { ${imported} } from "${m[2]}", which no longer exports it`);
      }
    }
  }
}

// 2. Config still pointing at a deleted workspace app. Derived from the deletion set: an app
//    directory counts as deleted when every file it had is gone.
const deletedApps = [
  ...new Set(
    [...doomed].filter((f) => f.startsWith("apps/")).map((f) => f.split("/")[1])
  ),
].filter((app) => !existsSync(join(CWD, "apps", app)));

/**
 * Documentation-bearing JSON keys. A `description` explaining WHY a rung's topology must not be
 * modelled is prose, not a dependency — flagging it is the 135-hit identifier grep all over
 * again, where the check measured text instead of structure.
 */
const isDocValue = (line) => /^\s*"(_[^"]*|description|title|\$comment)"\s*:/.test(line);

for (const f of surviving) {
  if (!/\.(ya?ml|json|ts|mjs|sh)$/.test(f)) continue;
  if (f === "rungs.json" || f.startsWith("docs/") || f.startsWith(".planning/"))
    continue;
  // Strip comments in code, and documentation values in JSON. Without this, a doc comment
  // pointing a reader at apps/open-swe/docs/LOCAL-AGENT.md counted as a dependency on the app.
  const raw = readFileSync(join(CWD, f), "utf8");
  const src = (/\.(ts|mjs)$/.test(f) ? stripComments(raw) : raw)
    .split("\n")
    .filter((line) => !(/\.json$/.test(f) && isDocValue(line)))
    .filter((line) => !/\.(sh|ya?ml)$/.test(f) || !/^\s*#/.test(line))
    .join("\n");
  const srcLines = src.split("\n");
  for (const app of deletedApps) {
    const re = new RegExp(`(apps/${app}\\b|--filter[= ]${app}\\b|filter[= ]"?${app}\\b)`);
    srcLines.forEach((line, n) => {
      if (!re.test(line)) return;
      // Guard-aware, like scripts/assert-no-missing-workspace-invocations.mjs. Without this,
      // eject flagged its OWN guards: a `pnpm --filter open-swe` inside an
      // `if [ "$(node scripts/has-rung.mjs open-swe)" = "yes" ]` never runs in a tree without
      // the rung, and reporting it is a check that cannot tell a live reference from a dead one.
      const window = srcLines.slice(Math.max(0, n - 25), n).join("\n");
      if (new RegExp(`has-rung\\.mjs["']?\\s+${app}\\b`).test(window)) return;
      leaks.push(`${f}:${n + 1} references deleted app "apps/${app}"`);
    });
  }
}

if (leaks.length > 0) {
  // Verification failure is not "eject went wrong" — it is "this rung cannot be cleanly ejected
  // yet". Either way the tree must not be left half-ejected, so it rolls back like any other
  // failure: the caller gets a diagnosis AND their repo.
  throw new EjectVerificationError(leaks);
}

log(`  verify : no dangling imports, no config pointing at a deleted app`);
// THE VERDICT IS THE LAST LINE, ALWAYS, IN BOTH DIRECTIONS.
//
// eject's output was truncated with `tail -6` and read as success when the run had in fact
// refused and rolled back — the trailing lines of a REFUSAL looked like the trailing lines of a
// SUCCESS. That is atomicity creating a new false-green surface: the fix made failure harmless,
// and therefore made it quiet. A verdict that a pager can cut off is not a verdict.
log(
  `\nRESULT: ejected to "${target}". Run: pnpm install --frozen-lockfile && pnpm build && pnpm test`
);

// --- end of the mutating phase --------------------------------------------------------------
} catch (err) {
  const restored = rollback();
  if (err instanceof EjectVerificationError) {
    console.error(
      `FAIL: ejecting to "${target}" would leave ${err.leaks.length} dangling reference(s):`
    );
    for (const l of err.leaks.slice(0, 25)) console.error(`       ${l}`);
    if (err.leaks.length > 25) console.error(`       ...and ${err.leaks.length - 25} more`);
  } else {
    console.error(`FAIL: eject failed partway through:\n       ${err?.message ?? err}`);
  }
  console.error(
    restored
      ? `\n       TREE RESTORED — nothing was left half-ejected.\n` +
          `\nRESULT: refused, tree restored. Nothing was ejected.`
      : `\n       WARNING: rollback itself failed. Recover with:\n` +
          `         git reset --hard HEAD && git clean -fd\n` +
          `\nRESULT: FAILED and the tree may be inconsistent — recover before continuing.`
  );
  process.exit(1);
}
