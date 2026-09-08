#!/usr/bin/env node
/**
 * NO TRACKED TEXT FILE CONTAINS A RAW NUL (#1060).
 *
 * A literal 0x00 byte in a source file makes it BINARY to the tools people search with, and
 * the failure is silence rather than an error. Twice in two days, from the same reflex — NUL
 * is the textbook collision-proof separator for a composite key, so it gets typed into a
 * template literal and nothing objects at authoring time:
 *
 *     #935   `${fam}<NUL>${cp}`                 scripts/assert-font-stack-resolves.mjs   2026-09-07
 *     #1055  `${m.groups.agent}<NUL>${channel}` scripts/assert-pr-authorship-...mjs      2026-09-08
 *
 * #935 repaired the FILE. The class recurred the next day, which is the whole argument for a
 * guard: the repair that closes one instance leaves nothing behind that would stop the next.
 *
 * WHAT IT ACTUALLY COSTS, because every visible signal stays green. The runtime value is
 * correct, the tests pass, `git` renders the diff as text, CI is clean. The only symptom is
 * that a search finds nothing — and finding nothing is also what a correct file looks like,
 * so no one can tell the two apart from outside. Measured on #1055's file:
 *
 *     grep (the Claude Code wrapper, `ugrep … -I`)   exit 1, NO OUTPUT     silent false negative
 *     /usr/bin/grep                                  "Binary file … matches", exit 0, no lines
 *     git grep / ripgrep                             found it (3 hits)
 *     Node checkers reading bytes                    unaffected
 *
 * So the blast radius is precisely "whoever searches with a tool that skips binaries", which
 * on this board is every agent. It cost a reviewer a detour on #1055: the token was searched
 * for, nothing came back, and the instrument had to be proven broken before the file could be
 * read at all.
 *
 * ─── WHY NOT `git`'s OWN BINARY DETECTION, WHICH WOULD BE THE PRINCIPLED CHOICE ───
 *
 * BECAUSE IT WOULD HAVE MISSED BOTH INSTANCES. git inspects only the FIRST 8000 BYTES for a
 * NUL. #1055's byte was at offset 10112, past the window, which is exactly why `git diff`
 * rendered that file as text (`numstat 431/0`, not `-`) while `file(1)` and ugrep called it
 * binary. Driven, with the boundary bracketed:
 *
 *     NUL at offset    100    git says BINARY   agrees
 *     NUL at offset   7999    git says BINARY   agrees
 *     NUL at offset   8001    git says text     DISAGREES — git misses it
 *     NUL at offset  10112    git says text     DISAGREES — the real #1055 case
 *
 * A guard delegating to git would go green on the defect it exists to catch. So the scan reads
 * every byte of every tracked file: 1669 files, 16.3 MB, 0.16s — the whole-file read is
 * affordable and the 8000-byte shortcut is the one thing it must not take.
 *
 * ─── AND NOT `grep`, WHICH IS THE OTHER THING THE NEXT PERSON WILL REACH FOR ───
 *
 * `grep -qU $'\x00'` DOES NOT SEARCH FOR A NUL. The shell strips the byte from the argument,
 * leaving an EMPTY pattern, which matches every file. Measured on this repository during
 * #1060's own investigation: it reported `.gitignore`, `.md` and `.yml` files as NUL-bearing.
 * A vacuous instrument that answers "everything" is no better than one that answers "nothing";
 * both are indistinguishable from a real result until something contradicts them. Read bytes
 * in Node and test for 0x00 directly, as below.
 *
 * ─── THE ALLOWLIST IS BY EXTENSION, AND THAT IS A MEASURED CHOICE ───
 *
 * Seven tracked files legitimately contain NULs: one `.pyc`, four `.png`, two `.bundle`. Three
 * extensions cover all of them, and on today's tree the extension rule, the byte scan and git's
 * verdict agree exactly — 7 files, no disagreement.
 *
 * A PATH LIST WOULD HAVE BEEN WORSE, and the reason is maintenance rather than taste: four of
 * the seven are visual-regression snapshots, so adding one card adds a PNG and a path list needs
 * pruning on every baseline change. An extension list does not move. And when a genuinely new
 * binary TYPE arrives the guard fires and someone adds one line with a visible reason — loud on
 * arrival, which is the right direction for a guard whose failure mode is silence.
 *
 * AN UNUSED ALLOWANCE IS A FINDING, not a tidy-up. An exception that no longer excepts anything
 * is an exception list outliving the situation that justified it, and the next reader cannot
 * tell a live entry from a dead one. Same argument as `staleExemptions` in
 * assert-pr-authorship-is-attributable.
 *
 * WHAT THIS DOES NOT CLAIM. It says nothing about other control bytes, about invalid UTF-8, or
 * about a file that is binary for some reason other than a NUL. It also cannot see an untracked
 * file — `git ls-files` is the subject — which is correct here, because the defect matters when
 * it is committed and searched by someone else.
 *
 * Exit 0 no tracked text file holds a NUL · 1 at least one does, or an allowance is unused ·
 * 2 the tree could not be listed, so the question could not be asked.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * Extensions whose files are binary by nature. Lower-cased at the comparison, so `.PNG` is the
 * same allowance as `.png` — a case-sensitive list would be an allowance that silently does not
 * apply, which is the shape this whole file is about.
 */
export const ALLOWED_BINARY_EXTENSIONS = Object.freeze(
  new Set([".pyc", ".png", ".bundle"])
);

export const isAllowedBinary = (path) =>
  ALLOWED_BINARY_EXTENSIONS.has(extname(path).toLowerCase());

/**
 * The offset of the first NUL, or -1. Reads the WHOLE buffer: the 8000-byte window is git's
 * shortcut and taking it is how this guard would miss the case it was written for.
 */
export function firstNulOffset(bytes) {
  return bytes.indexOf(0);
}

/** 1-based line number of a byte offset, so the complaint points somewhere a person can look. */
export function lineOfOffset(bytes, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < bytes.length; i++) {
    if (bytes[i] === 0x0a) line++;
  }
  return line;
}

/**
 * @param files    tracked paths, repo-relative
 * @param read     (path) => Buffer — injected so the selftest can drive this over planted
 *                 content without writing into the repository it is asserting about
 */
export function scan(files, read) {
  const violations = [];
  const extensionsUsed = new Set();
  let examined = 0;

  for (const path of files) {
    const bytes = read(path);
    if (bytes === null) continue;
    examined++;
    const offset = firstNulOffset(bytes);
    if (offset === -1) continue;
    if (isAllowedBinary(path)) {
      extensionsUsed.add(extname(path).toLowerCase());
      continue;
    }
    violations.push({ path, offset, line: lineOfOffset(bytes, offset) });
  }

  const unusedAllowances = [...ALLOWED_BINARY_EXTENSIONS].filter(
    (e) => !extensionsUsed.has(e)
  );
  return { examined, violations, unusedAllowances };
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function main() {
  let files;
  try {
    files = trackedFiles();
  } catch (e) {
    console.error(
      `REFUSE: could not list the tracked tree, so "no text file holds a NUL" is not a\n` +
        `        statement anyone can make about this repository.\n        ${e.message}`
    );
    process.exit(2);
  }

  const read = (path) => {
    const full = join(ROOT, path);
    try {
      if (!statSync(full).isFile()) return null;
      return readFileSync(full);
    } catch {
      // A tracked path that is not readable HERE — a submodule, a broken symlink, a
      // sparse checkout. Skipping is right and the subject count says how many were
      // actually read, so a run that skipped everything cannot look like a clean one.
      return null;
    }
  };

  const { examined, violations, unusedAllowances } = scan(files, read);

  if (violations.length > 0) {
    console.error(
      `FAIL: ${violations.length} tracked text file(s) contain a raw NUL (0x00):`
    );
    for (const v of violations.slice(0, 20)) {
      console.error(`  - ${v.path} at byte ${v.offset} (line ${v.line})`);
    }
    if (violations.length > 20) {
      console.error(`  ... and ${violations.length - 20} more.`);
    }
    console.error(
      `\n      A NUL makes the file binary to every tool that skips binaries — the grep this\n` +
        `      board's agents use returns NOTHING and exits 1, which is indistinguishable from\n` +
        `      a clean search. Everything else stays green: the runtime value is correct, the\n` +
        `      tests pass, and git renders the diff as text because git only inspects the first\n` +
        `      8000 bytes.\n\n` +
        `      REPAIR: write the escape, not the byte. In a JS string \`\\0\` produces the same\n` +
        `      character at runtime and leaves the source readable. If the NUL is a separator in\n` +
        `      a composite key, check whether it is even needed — a key built from parts that\n` +
        `      cannot contain whitespace is unambiguous with a space.\n\n` +
        `      If the file is genuinely binary, add its extension to ALLOWED_BINARY_EXTENSIONS\n` +
        `      in this checker, with the reason.`
    );
    process.exit(1);
  }

  if (unusedAllowances.length > 0) {
    console.error(
      `FAIL: ${unusedAllowances.length} allowance(s) in ALLOWED_BINARY_EXTENSIONS no longer\n` +
        `      except anything: ${unusedAllowances.join(", ")}\n\n` +
        `      No tracked file with that extension carries a NUL any more. An exception that\n` +
        `      excepts nothing is an exception list outliving the situation that justified it,\n` +
        `      and the next reader cannot tell a live entry from a dead one. Remove it.`
    );
    process.exit(1);
  }

  reportSubject(examined, "tracked file(s) read byte by byte for a NUL");
  console.log(
    `PASS: no tracked text file contains a raw NUL.\n` +
      `      ${ALLOWED_BINARY_EXTENSIONS.size} binary extension(s) allowed, all of them in use.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
