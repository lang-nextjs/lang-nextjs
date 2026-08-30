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
 * KNOWN GAP, STATED RATHER THAN PAPERED OVER. A stale tree that DELETES a file added after its
 * snapshot is not caught, because deletion is indistinguishable from legitimate removal under
 * this signal (29/29 measured firings were legitimate). The specimen does not have this shape —
 * all seven of its reverts are modifications — so the gap is real but was not what bit us.
 * Closing it needs a different instrument, not a laxer threshold here.
 *
 * REFUSALS, BECAUSE A VERDICT THIS CHECK NEVER COMPUTED MUST NOT LOOK LIKE A PASS. A SHALLOW
 * CLONE IS THE DANGEROUS ONE: `actions/checkout` defaults to `fetch-depth: 1`, and with one
 * commit of history `git log <base> -- <path>` returns nothing, no revert is ever found, and
 * this exits 0 having compared against an empty past. That is how this check would be born
 * vacuous in CI, so it refuses instead.
 *
 * Exit codes:  0 = no undeclared revert   1 = property violated   2 = could not be checked
 *
 * Usage: node scripts/assert-no-undeclared-reverts.mjs [--base REF] [--head REF] [--cwd DIR]
 */
import { execFileSync } from "node:child_process";
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
   * anything. Refuse rather than answer.
   */
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Refusal(
      "the repository is a SHALLOW clone, so no file has a past here and this check would " +
        "find nothing no matter what the branch did.\n" +
        "      Set `fetch-depth: 0` on actions/checkout for the job that runs this."
    );
  }

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
  let deletions = 0;
  let exempt = 0;
  let searched = 0;

  for (const f of changed) {
    if (f.headBlob === f.baseBlob) continue;
    // A submodule pointer is not file content; blob identity means something else there.
    if (f.oldMode === "160000" || f.newMode === "160000") continue;
    if (f.headBlob === ZERO) {
      deletions++;
      continue; // see KNOWN GAP in the header
    }
    if (DERIVED_ARTIFACTS.includes(f.path)) {
      exempt++;
      continue;
    }

    searched++;
    const hist = fileHistory(git, baseSha, f.path);
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

  return {
    baseSha, headSha,
    compared: changed.length,
    searched, deletions, exempt,
    reverts, declared,
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
