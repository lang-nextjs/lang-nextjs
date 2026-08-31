#!/usr/bin/env node
/**
 * assert-no-undeclared-reverts.mjs — a branch must not silently undo work that is already
 * in its own base.
 *
 * THE DEFECT, MEASURED (#406). `feat/377-runtime-parity` (`57cfa40`, preserved as
 * `specimen/stale-tree-reverts-398`) produced one commit PARENTED on current main carrying a
 * tree from before three merged PRs. Seven files were byte-identical to a state that main had
 * already moved past, so merging the branch would have undone #396, #397 and #398 — including
 * a comment that had been disproved and a test field whose absence kept a job red for twelve
 * consecutive pushes.
 *
 * EVERY PRE-MERGE GATE WAS GREEN, AND CORRECTLY SO. A REVERT IS SELF-CONSISTENT: #398's tests
 * were reverted along with #398's code, so nothing was left behind to fail. `tsc` typechecks
 * whatever tree it is handed. The census counts files, not provenance. CI on the PR would have
 * run the reverted spec against the reverted workflow and agreed with itself. The only job that
 * would have failed is push-to-main only, so it fails AFTER the merge button.
 *
 * `git merge-base` does not close this. It proves the PARENT is fresh and says nothing about
 * the TREE, and that gap is the entire bug.
 *
 * THE SIGNAL. For each file in the diff, if the head blob is byte-identical to a state that
 * file held at some ANCESTOR OF THE BASE and differs from the base, the branch is undoing the
 * commit that superseded that state. `git log --raw <base> -- <path>` walks only ancestors of
 * base and yields every historical blob in one call, so this is blob comparison — no patch-id
 * analysis, no content heuristics.
 *
 * WHY MODIFICATIONS ONLY, AND THE MEASUREMENT THAT DECIDED IT. Swept over the 80 most recent
 * single-parent commits on main, each against its own parent:
 *
 *     77 clean, 3 would fire, 29 file-hits — and ALL 29 were deletions.
 *
 * Zero false positives from modification; every deletion firing was legitimate work. That is
 * structural rather than luck: deleting a file always matches the state before it was added,
 * so under this signal EVERY file removal reads as a revert. One firing flagged two files
 * literally named `0.0.0.0:9999` and `127.0.0.1:3100` — junk from a stray shell redirect,
 * later cleaned up. Flagging deletions would make this check noise, and a check that is red
 * for legitimate work gets muted. Deletions are therefore COUNTED AND REPORTED but never
 * failed, so the gap stays visible instead of being silently dropped. See KNOWN GAP below.
 *
 * WHY DERIVED ARTIFACTS ARE EXEMPT, ALSO MEASURED. `rungs.json` genuinely returned to an
 * earlier blob twice in 72 revisions (`846e0f1` back to `3a1221a`'s blob; `b598973` back to
 * `496f9cc`'s) because `ownedFileCount` went up and came back down as files came and went.
 * That is a count nobody authored — a function of the tree — so its returning to an earlier
 * value carries no intent to undo anything. It also cannot hide a regression: `pnpm rungs` and
 * `pnpm census` RECOMPUTE these from the tree, so a wrong value fails there, loudly, in a check
 * that already owns it. Exempting them is declining to duplicate a signal, not creating a hole.
 * The exemption is itself checked for staleness below.
 *
 * HOW A DELIBERATE REVERT DECLARES ITSELF. A deliberate revert is legitimate and must pass.
 * This check CANNOT distinguish it structurally — `git revert <C>` and an accidentally stale
 * tree produce byte-identical results, because both restore the pre-C content. Nothing in the
 * tree separates them, so the discriminator has to be INTENT, and intent has to be written
 * down. A revert of commit C is accepted when some commit message in `base..head` carries
 * either form:
 *
 *     This reverts commit <sha>.        <- git revert writes this for free
 *     Revert-Of: <sha>                  <- for a revert done by hand
 *
 * The declaration NAMES THE COMMIT, so it accepts a revert of C and nothing else. A stale tree
 * would have to name all three commits it does not know it is undoing.
 *
 * THE MATCH IS ON A TRAILER, NEVER ON THE WORD "REVERT", and the specimen is why. Its own
 * commit message contains "could be reverted to the exact pre-#360 behaviour with a green
 * suite" — a sentence ABOUT reverting, in the very commit that reverts three PRs by accident.
 * A `/revert/i` matcher would accept the specimen and this check would ship inverted. That
 * case is pinned in the selftest.
 *
 * KNOWN GAP, NARROWED IN TWO PLACES AND STILL DECLARED (#507). A stale tree that DELETES a file
 * added after its snapshot is not caught by the signal above, because deletion is
 * indistinguishable from legitimate removal: a tree that NEVER HAD the file and a tree that
 * deliberately removed it are byte-identical, and nothing in the commit records which snapshot
 * it was built from. That is a property of the content, not a threshold, and no amount of
 * tuning changes it.
 *
 * The gap got its first live instance within a day of shipping: a `git reset --soft origin/main`
 * squash undid three files of #489 AND deleted that PR's 113-line test outright. The three were
 * named and the deletion was not, so the report understated the loss in the one direction that
 * matters — for a deletion the evidence of the loss IS the thing being lost.
 *
 * What changed:
 *
 *   1. A DIFF THAT IS ONLY DELETIONS NOW REFUSES. The instance reported, in its own words,
 *      `PASS ... compared 1 changed file(s); searched the history of 0` — it declined to examine
 *      every changed file and then announced it had found nothing. That is the zero-file refusal
 *      this check already had, one level in. A stale tree has exactly this signature whenever
 *      its base's advance was ADDITIONS-ONLY, which is every PR that adds a test or a script.
 *      The refusal is dischargeable by `Revert-Of:`, like any other, so a deliberate removal is
 *      not blocked — only an unexplained one.
 *
 *   2. DELETIONS ARE ATTRIBUTED once staleness is already proved. A deleted file whose ADDING
 *      commit is one of the commits this run is already reporting as undone is named alongside
 *      the modifications. This cannot produce a false positive: it only prints inside a report
 *      that is already failing.
 *
 * MEASURED BEFORE ADOPTING (1): over the last 300 single-parent commits on main, 14 contain
 * deletions and ZERO are deletions-only, so the new refusal costs nothing on real work. Note
 * that merged history is the RIGHT population for a FALSE-POSITIVE rate — every commit in it is
 * legitimate — and the WRONG one for the question the 29/29 sweep was read as answering, since
 * it can only contain the deletions that survived review.
 *
 * THE RESIDUAL, PINNED BY A SELFTEST CASE RATHER THAN LEFT TO BE REDISCOVERED: a stale tree that
 * also carries its own new work has `searched > 0`, so (1) does not fire, and if it reverts
 * nothing by modification then (2) has nothing to attach to. That case still passes. Closing it
 * needs a record of the snapshot the tree was built from, which git does not keep — a different
 * instrument, as before, and not a laxer threshold here.
 *
 * REFUSALS, BECAUSE A VERDICT THIS CHECK NEVER COMPUTED MUST NOT LOOK LIKE A PASS. A TRUNCATED
 * CLONE IS THE DANGEROUS ONE: `actions/checkout` defaults to `fetch-depth: 1`, and with one
 * commit of history `git log <base> -- <path>` returns nothing, no revert is ever found, and
 * this exits 0 having compared against an empty past. That is how this check would be born
 * vacuous in CI, so it refuses instead.
 *
 * THE REFUSAL IS ABOUT THE FILE'S PAST, NOT ABOUT A FLAG, AND #427 IS WHY. This first asked
 * `git rev-parse --is-shallow-repository`, which was a PROXY for the property it needs. git
 * sets that flag the moment `$GIT_DIR/shallow` OPENS, so an EMPTY shallow file reports
 * "shallow" while cutting nothing at all — and CI ran on a clone in exactly that state. The
 * flag said true; `git rev-parse <specimen>^` resolved; the history was present the whole
 * time; this check refused anyway and #427 was red on its own proof. Reproducing the runner's
 * checkout exactly, against the real remote and under the runner's own git 2.55.0, produced a
 * NON-shallow clone and 14/14 — so the flag and the property came apart on the only clone that
 * mattered, and nothing in the tree could be found that writes the file.
 *
 * WHAT IT ASKS NOW is the property: FOR THIS FILE, CAN I SEE ITS WHOLE PAST? A file's history
 * is complete when the walk reaches the commit that ADDED it (`before` all zeroes) at a commit
 * that is NOT a shallow boundary. The boundary qualifier is load-bearing: git grafts boundary
 * commits parentless, so at a boundary EVERY file reads as "added here" — which is precisely
 * the shape a truncated history takes, and precisely what a naive "did I see the add?" test
 * would accept. Boundaries come from the shallow file's CONTENTS, so an empty one is what it
 * says it is: no commit was cut.
 *
 * That is strictly stronger than the flag rather than laxer. A depth-limited clone is one bit
 * either way, but "deep enough" is a per-file question: a file added after the boundary is
 * fully readable in the same clone in which an older file is not. The flag cannot express
 * that; both selftest cases below run against clones the flag calls shallow, and one of them
 * FIRES on a real revert rather than refusing.
 *
 * Exit codes:  0 = no undeclared revert   1 = property violated   2 = could not be checked
 *
 * Usage: node scripts/assert-no-undeclared-reverts.mjs [--base REF] [--head REF] [--cwd DIR]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/**
 * Content that is DERIVED FROM THE TREE rather than authored. See the header: another check
 * recomputes each of these, so a stale value fails there rather than being hidden here.
 */
export const DERIVED_ARTIFACTS = Object.freeze([
  "rungs.json",
  "scripts/shared-census.json",
]);

const ZERO = "0".repeat(40);

class Refusal extends Error {}

function makeGit(cwd) {
  return (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "pipe"],
    });
}

/**
 * Every state `file` has held across ancestors of `base`, newest first, as
 * {commit, before, after}. `before` at row i is a state that existed until commit i superseded
 * it — which is exactly the thing a revert restores.
 *
 * `--no-renames` is deliberate: rename detection would report a path the diff never named, and
 * the comparison must be about the path as written.
 */
export function fileHistory(git, base, file) {
  let out;
  try {
    out = git("log", "--raw", "--no-abbrev", "--no-renames", "--format=C %H", base, "--", file);
  } catch {
    return [];
  }
  const rows = [];
  let commit = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("C ")) commit = line.slice(2).trim();
    else if (line.startsWith(":") && commit) {
      const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) /);
      if (m) rows.push({ commit, oldMode: m[1], newMode: m[2], before: m[3], after: m[4] });
    }
  }
  return rows;
}

/**
 * The commits where this clone's history was CUT, read from the shallow file's CONTENTS.
 *
 * NOT `git rev-parse --is-shallow-repository`, and the difference is the whole of #427: git
 * sets that flag as soon as `$GIT_DIR/shallow` can be OPENED, so an empty file answers "yes,
 * shallow" while listing no boundary and cutting no history. An empty list here means what it
 * says — nothing was cut — and a non-empty one names the commits git will present as
 * parentless.
 *
 * Unreadable for any reason is treated as NO boundaries, which is safe in the only direction
 * that matters: it can only let the per-file completeness test below run, and that test proves
 * the past it needs rather than assuming it.
 */
export function shallowFilePath(git, cwd) {
  try {
    return resolve(cwd, git("rev-parse", "--git-path", "shallow").trim());
  } catch {
    return null;
  }
}

/**
 * WHEN the boundary appeared, because WHICH boundary is only half the question.
 *
 * A clone that arrives truncated and a clone something truncated MID-RUN need opposite fixes,
 * and they produce an identical refusal. #427 cost three rounds on exactly that ambiguity: a
 * step immediately before this check reported the clone COMPLETE, and nine seconds later this
 * found a boundary. Without the timestamp the refusal reads as "the checkout was shallow",
 * which was wrong twice.
 */
function shallowFileWritten(path) {
  try {
    const st = statSync(path);
    return `${st.mtime.toISOString()} (${st.size} bytes)`;
  } catch {
    return "unknown";
  }
}

export function shallowBoundaries(git, cwd) {
  const where = shallowFilePath(git, cwd);
  if (!where) return [];
  let body;
  try {
    body = readFileSync(where, "utf8");
  } catch {
    return []; // no such file: a complete clone
  }
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40}$/.test(line));
}

/**
 * Declarations of intent found in `base..head`.
 *
 * Both forms name a commit. A declaration accepts a revert OF THAT COMMIT and nothing else, so
 * declaring one revert does not open the branch to reverting anything at all.
 */
export function declaredReverts(messages) {
  const shas = new Set();
  for (const msg of messages) {
    for (const m of msg.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)) shas.add(m[1].toLowerCase());
    for (const m of msg.matchAll(/^\s*Revert-Of:\s*([0-9a-f]{7,40})\b/gim)) shas.add(m[1].toLowerCase());
  }
  return shas;
}

/** A declaration matches a commit when either sha is a prefix of the other (git abbreviates). */
export function isDeclared(commitSha, declarations) {
  for (const d of declarations) {
    if (commitSha.startsWith(d) || d.startsWith(commitSha)) return true;
  }
  return false;
}

export function analyse({ cwd = ROOT, base, head = "HEAD" } = {}) {
  const git = makeGit(cwd);

  try {
    git("rev-parse", "--git-dir");
  } catch {
    throw new Refusal(`${cwd} is not a git repository, so nothing could be compared.`);
  }

  /*
   * THE VACUITY THAT WOULD HAVE SHIPPED. With `fetch-depth: 1` there is one commit of history,
   * every file's past is empty, and this returns "no reverts found" without having looked at
   * anything.
   *
   * The boundaries are read here and SPENT PER FILE below, rather than refused on the spot.
   * Truncation is not a property of the clone, it is a property of the clone AND the file: a
   * file added after the cut is fully readable in a clone where an older one is not.
   */
  const boundaries = new Set(shallowBoundaries(git, cwd));

  const resolve1 = (ref) => {
    try {
      return git("rev-parse", "--verify", `${ref}^{commit}`).trim();
    } catch {
      return null;
    }
  };

  const headSha = resolve1(head);
  if (!headSha) throw new Refusal(`could not resolve head ref "${head}".`);

  let baseSha = base ? resolve1(base) : null;
  if (base && !baseSha) throw new Refusal(`could not resolve base ref "${base}".`);

  if (!baseSha) {
    // No base given. Prefer the PR's base branch; fall back to origin/main; and if HEAD already
    // IS that base (a push to main), compare the pushed commit against its own parent — which
    // is a real subject, not an empty one.
    const candidates = [
      process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
      "origin/main",
      "main",
    ].filter(Boolean);
    for (const c of candidates) {
      const sha = resolve1(c);
      if (!sha) continue;
      const mb = git("merge-base", sha, headSha).trim();
      if (mb !== headSha) {
        baseSha = mb;
        break;
      }
    }
    if (!baseSha) baseSha = resolve1(`${headSha}^`);
  }

  if (!baseSha) {
    throw new Refusal(
      "could not determine a base to compare against — no PR base, no origin/main, and " +
        "head has no parent."
    );
  }
  if (baseSha === headSha) {
    throw new Refusal(
      `base and head are the same commit (${headSha.slice(0, 7)}), so the diff is empty and ` +
        `any verdict would be about nothing.`
    );
  }

  /*
   * THE EXEMPTION MUST NOT GO STALE. If a derived artifact is renamed or removed, this list
   * silently stops exempting anything and the ACCEPT behaviour proved in the selftest is no
   * longer the behaviour shipping. That is a wrong answer, so it is a refusal.
   */
  const missing = DERIVED_ARTIFACTS.filter((p) => {
    try {
      git("cat-file", "-e", `${baseSha}:${p}`);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) {
    throw new Refusal(
      `the derived-artifact exemption names ${missing.join(", ")}, which does not exist at ` +
        `the base.\n      The exemption is stale, so this check's ACCEPT behaviour is no ` +
        `longer what was proved. Update DERIVED_ARTIFACTS.`
    );
  }

  // One `git diff --raw` yields the base blob AND the head blob for every changed path.
  const rawDiff = git("diff", "--raw", "--no-abbrev", "--no-renames", baseSha, headSha);
  const changed = [];
  for (const line of rawDiff.split("\n")) {
    const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) (\w)\d*\t(.+)$/);
    if (m) {
      changed.push({
        oldMode: m[1], newMode: m[2], baseBlob: m[3], headBlob: m[4], status: m[5], path: m[6],
      });
    }
  }

  if (changed.length === 0) {
    throw new Refusal(
      `${baseSha.slice(0, 7)}..${headSha.slice(0, 7)} changes no files, so zero files were ` +
        `compared and there is no verdict to give.`
    );
  }

  const messages = git("log", "--format=%B%x00", `${baseSha}..${headSha}`).split("\0");
  const declarations = declaredReverts(messages);

  const reverts = [];
  const declared = [];
  const truncated = [];
  const deleted = [];
  let exempt = 0;
  let searched = 0;

  for (const f of changed) {
    if (f.headBlob === f.baseBlob) continue;
    // A submodule pointer is not file content; blob identity means something else there.
    if (f.oldMode === "160000" || f.newMode === "160000") continue;
    if (f.headBlob === ZERO) {
      /*
       * STILL NOT FAILED — the sweep's finding holds and flagging every deletion is noise.
       * But the ADDING COMMIT is recorded now, because it is what lets a deletion be
       * ATTRIBUTED to a stale tree this run has already proved by other means (#507).
       */
      const addedBy = fileHistory(git, baseSha, f.path).find((r) => r.before === ZERO);
      deleted.push({ path: f.path, addedBy: addedBy ? addedBy.commit : null });
      continue; // see KNOWN GAP in the header
    }
    if (DERIVED_ARTIFACTS.includes(f.path)) {
      exempt++;
      continue;
    }

    searched++;
    const hist = fileHistory(git, baseSha, f.path);

    /*
     * CAN I SEE THIS FILE'S WHOLE PAST? Only if the walk reaches the commit that ADDED it, at a
     * commit that is NOT a boundary. A boundary is grafted parentless, so every file in its
     * tree reads as "added there" — the add this looks for has to be a real one, or the test
     * accepts exactly the truncation it exists to catch.
     *
     * A file the branch ADDS (`baseBlob` all zeroes) has no past at the base to be cut, so its
     * absence there is complete knowledge rather than missing knowledge.
     */
    if (boundaries.size && f.baseBlob !== ZERO) {
      const sawTheAdd = hist.some((r) => r.before === ZERO && !boundaries.has(r.commit));
      if (!sawTheAdd) {
        truncated.push(f.path);
        continue;
      }
    }

    for (const row of hist) {
      if (row.before === f.headBlob && row.before !== ZERO) {
        const hit = {
          path: f.path,
          undoes: row.commit,
          subject: git("log", "-1", "--format=%s", row.commit).trim(),
        };
        if (isDeclared(row.commit, declarations)) declared.push(hit);
        else reverts.push(hit);
        break;
      }
    }
  }

  /*
   * A VERDICT OVER A FILE WHOSE PAST WAS CUT IS NOT A VERDICT. At a boundary the file reads as
   * newly added, so a revert of anything older is INVISIBLE and this would exit 0 having found
   * nothing — the same vacuity the refusal exists for, arrived at per file instead of per clone.
   */
  if (truncated.length) {
    const shown = truncated.slice(0, 5).map((x) => `        ${x}`).join("\n");
    throw new Refusal(
      `this clone's history is CUT at ${boundaries.size} boundary commit(s), and ` +
        `${truncated.length} of the ${searched} file(s) searched cannot be read back to the ` +
        `commit that added them:\n${shown}` +
        (truncated.length > 5 ? `\n        …and ${truncated.length - 5} more` : "") +
        `\n      At a boundary a file reads as "added there", so a revert of anything older is ` +
        `invisible and this would report a clean pass over a past it never saw.\n` +
        `      Set \`fetch-depth: 0\` on actions/checkout for the job that runs this, or ` +
        `\`git fetch --no-tags --unshallow origin\`.\n` +
        `      Boundary: ${[...boundaries][0]}\n` +
        `      The shallow file was written at ${shallowFileWritten(shallowFilePath(git, cwd))} — ` +
        `compare that against\n      the checkout's timestamp: a clone that ARRIVED truncated ` +
        `and one something truncated during\n      the run need different fixes and refuse ` +
        `identically.` +
        (reverts.length
          ? `\n      NOTE: ${reverts.length} undeclared revert(s) were already found in the ` +
            `part that COULD be read. Deepening the clone will not make those go away.`
          : "")
    );
  }

  /*
   * A PASS OVER AN EMPTY SEARCH SET IS A VERDICT ABOUT NOTHING (#507).
   *
   * The first live instance of the deletion gap reported, in its own words,
   * `PASS ... compared 1 changed file(s); searched the history of 0` — every changed file was
   * a deletion, so the check declined to examine any of them and then said it had found no
   * revert. That is the same shape this file already refuses for a zero-file diff, one level in:
   * nothing was compared THAT THIS CHECK LOOKS AT.
   *
   * A stale tree deleting files main added since its snapshot has exactly this signature when
   * main's advance was additions-only, which is common — every PR that adds a test or a script.
   *
   * MEASURED BEFORE ADOPTING, over the last 300 single-parent commits on main: 14 contain
   * deletions, and ZERO have `searched === 0`. So this costs nothing on real work. That
   * population is the RIGHT one for a false-positive rate — every commit in merged history is
   * legitimate — unlike the 29/29 sweep that justified the gap, which asked whether
   * ILLEGITIMATE deletions occur of a population that by construction contains none.
   */
  const undeclaredDeletions = deleted.filter(
    (d) => !d.addedBy || !isDeclared(d.addedBy, declarations)
  );
  if (searched === 0 && undeclaredDeletions.length) {
    throw new Refusal(
      `every changed file was a deletion, so this examined NOTHING and cannot say whether the ` +
        `branch undoes merged work.\n` +
        undeclaredDeletions.slice(0, 5).map((d) => `        ${d.path}`).join("\n") +
        (undeclaredDeletions.length > 5
          ? `\n        …and ${undeclaredDeletions.length - 5} more`
          : "") +
        `\n      A stale tree deletes exactly the files its base gained after the snapshot, and ` +
        `when that\n      advance was additions-only there is nothing left for this check to ` +
        `compare.\n` +
        `      If the removals are deliberate, say so in a commit message and this passes:\n` +
        [...new Set(undeclaredDeletions.filter((d) => d.addedBy).map((d) => d.addedBy))]
          .map((c) => `          Revert-Of: ${c.slice(0, 12)}`)
          .join("\n")
    );
  }

  return {
    baseSha, headSha,
    compared: changed.length,
    searched, deletions: deleted.length, exempt,
    boundaries: boundaries.size,
    reverts, declared, deleted,
    declarations: [...declarations],
  };
}

function main() {
  const cwd = resolve(argOf("--cwd", ROOT));
  let r;
  try {
    r = analyse({ cwd, base: argOf("--base", null), head: argOf("--head", "HEAD") });
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSE: ${e.message}`);
      console.error(`        Nothing was compared, which is not the same as nothing being wrong.`);
      process.exit(2);
    }
    throw e;
  }

  const range = `${r.baseSha.slice(0, 7)}..${r.headSha.slice(0, 7)}`;
  const tail =
    `      compared ${r.compared} changed file(s) over ${range}; searched the history of ` +
    `${r.searched}\n` +
    `      (${r.deletions} deletion(s) not classified — see KNOWN GAP; ${r.exempt} derived ` +
    `artifact(s) exempt)`;

  if (r.reverts.length === 0) {
    let head = `PASS: no undeclared revert of merged work in ${range}.`;
    if (r.declared.length) {
      head +=
        `\n      ${r.declared.length} file(s) DO revert merged work and are accepted because ` +
        `the branch declared it:`;
    }
    console.log(head);
    for (const d of r.declared) {
      console.log(`        ${d.path}\n            declared revert of ${d.undoes.slice(0, 7)} ${d.subject}`);
    }
    console.log(tail);
    return;
  }

  const undone = [...new Set(r.reverts.map((x) => x.undoes))];
  console.error(
    `FAIL: ${r.reverts.length} file(s) in ${range} are byte-identical to a state this base ` +
      `already moved past,\n      and no commit in the branch declares the revert. Merging ` +
      `would undo ${undone.length} merged commit(s).\n`
  );
  for (const commit of undone) {
    const subject = r.reverts.find((x) => x.undoes === commit).subject;
    console.error(`  undoes ${commit.slice(0, 7)}  ${subject}`);
    for (const x of r.reverts.filter((y) => y.undoes === commit)) {
      console.error(`      ${x.path}`);
    }
    /*
     * DELETIONS ATTRIBUTED, NOT FLAGGED (#507). A deletion is still never a failure on its own —
     * that would reintroduce the 29 false positives the gap exists to avoid. But once THIS RUN
     * has proved the branch carries a stale tree, a file deleted here that was ADDED by one of
     * the commits being undone is part of the same loss, and naming it costs nothing: it can
     * only appear inside a report that is already failing.
     *
     * The live instance is why. A stale tree undid three files of #489 and DELETED that PR's
     * 113-line test outright; the three were named and the deletion was not, so the report
     * understated the loss in exactly the direction that matters — the deleted file was the
     * evidence of the loss AND the thing being lost.
     */
    for (const d of r.deleted.filter((x) => x.addedBy === commit)) {
      console.error(`      ${d.path}  (DELETED — added by this commit)`);
    }
    console.error("");
  }
  if (undone.length > 1) {
    console.error(
      `  These reverts undo ${undone.length} DIFFERENT merged commits, which is the fingerprint of a\n` +
        `  branch carrying a stale tree rather than of an intentional revert.\n`
    );
  }
  console.error(
    `  If this is DELIBERATE, say so and it passes — add to a commit message in this branch:\n` +
      undone.map((c) => `      Revert-Of: ${c.slice(0, 12)}`).join("\n") +
      `\n  (\`git revert <sha>\` writes an equivalent line by itself.)\n` +
      `\n  If it is NOT deliberate, the branch's tree predates its parent. Rebase onto the base\n` +
      `  and re-apply, rather than editing these files back by hand.\n`
  );
  console.error(tail);
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
