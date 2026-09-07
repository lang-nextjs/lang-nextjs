#!/usr/bin/env node
/**
 * Every action pin's version comment must name a tag that resolves to that pin's sha.
 *
 * A pin is `uses: owner/repo@<40-hex> # v6`. The sha is what runs; the comment is the ONLY
 * human-readable statement of what that sha is. Nothing resolved the two against each other,
 * so the comment was an ASSERTION rather than a derivation — the same shape as #855's
 * `ejectTarget` and #822's provenance fields, and it failed the same way.
 *
 * ── WHY THE OBVIOUS CHECK IS NOT THIS ONE ─────────────────────────────────────────────────
 *
 * #859 observed two pins of one action carrying the same sha and contradictory comments, and
 * the natural checker is "all pins of an action at one sha agree". That check is cheaper, needs
 * no network, and WOULD HAVE MISSED THE MAJORITY OF THE DEFECT. Measured on main at 3118f724:
 *
 *     actions/checkout          25 pins   comments v6/v5/v4   sha is tagged v7.0.1, v7
 *     actions/setup-node        22 pins   comments v6/v5      sha is tagged v7.0.0, v7
 *     actions/setup-python       1 pin    comment  v5         sha is tagged v7.0.0, v7
 *     actions/upload-artifact   14 pins   comments v7/v4      sha is tagged v7.0.1, v7
 *     pnpm/action-setup         20 pins   comments v6/v4      sha is tagged v6.0.10, v6
 *
 * FIFTY OF EIGHTY-TWO comments name a version the sha is not. Two of the five actions are wrong
 * in EVERY pin — where an agreement check finds nothing, because the pins agree with each other
 * and are uniformly wrong. And `actions/setup-python` has exactly ONE pin, so an agreement check
 * has no second line to compare it against and is silent by construction.
 *
 * A consistency check compares the artifact with itself. This resolves it against the thing it
 * describes, which is the only version that can be wrong about all of them at once.
 *
 * ── THE REFUSAL, AND IT IS THE POINT OF THE DESIGN ────────────────────────────────────────
 *
 * Tags are read from `repos/<action>/tags?per_page=100` — the most recent hundred. A sha older
 * than that window is NOT ABSENT FROM THE WORLD, it is absent from what was fetched, and
 * reporting it as a mismatch would be a claim about a pin from a reading that could not see it.
 *
 * That case exits 2 and names the pins it could not resolve. All five actions resolve inside the
 * window today — checkout's window reaches 68 tags, pnpm's 40 — so the refusal branch does not
 * fire on this tree. IT WILL. A pin that stops being bumped drifts out of the window while every
 * other pin keeps moving, and the day it does, the difference between "your comment is wrong"
 * and "I could not check your comment" is the difference between an edit and a lie.
 *
 * Exit 1 is reserved for a comment measured against tags that were actually read.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

/**
 * Pins in one workflow file.
 *
 * Anchored on a 40-hex sha so a floating `uses: actions/checkout@v4` is not matched — this
 * check is about pins that CARRY a sha, and a floating ref is a different defect with its own
 * checker. The comment is captured raw and trimmed; a pin with no comment yields `null`, which
 * is a violation rather than a pass, because a sha with nothing saying what it is defeats the
 * purpose the comment exists for.
 */
export function parsePins(source, file = "<source>") {
  const out = [];
  source.split("\n").forEach((text, i) => {
    const m = text.match(/uses:\s*([^@\s]+)@([0-9a-f]{40})\s*(?:#\s*(\S+))?/);
    if (!m) return;
    out.push({
      file,
      line: i + 1,
      action: m[1],
      sha: m[2],
      comment: m[3] ? m[3].trim() : null,
    });
  });
  return out;
}

/** sha -> the tag names pointing at it, from one `repos/<action>/tags` payload. */
export function tagsBySha(tags) {
  const m = new Map();
  for (const t of tags ?? []) {
    const sha = t?.commit?.sha;
    if (typeof sha !== "string" || typeof t?.name !== "string") continue;
    if (!m.has(sha)) m.set(sha, []);
    m.get(sha).push(t.name);
  }
  return m;
}

/**
 * One pin against one action's tag map.
 *
 * THE ORDER OF THESE BRANCHES IS THE CONTRACT. "Could not resolve the sha" is asked BEFORE
 * "does the comment match", because a comment cannot be judged against a reading that never
 * contained its sha. Reversing them turns every out-of-window pin into a false mismatch.
 */
export function classifyPin(pin, shaMap) {
  const tags = shaMap.get(pin.sha);
  if (!tags)
    return {
      kind: "unresolvable",
      pin,
      why:
        `${pin.action}@${pin.sha.slice(
          0,
          10
        )} is not among the tags read for ` +
        `${pin.action}, so its comment could not be checked. The tags API returns the most ` +
        `recent 100; a sha older than that window is unreadable here, NOT wrong.`,
    };
  if (!pin.comment)
    return {
      kind: "mismatch",
      pin,
      tags,
      why:
        `${pin.action}@${pin.sha.slice(0, 10)} carries no version comment. ` +
        `That sha is tagged ${tags.join(", ")}.`,
    };
  if (tags.includes(pin.comment)) return { kind: "ok", pin, tags };
  return {
    kind: "mismatch",
    pin,
    tags,
    why:
      `${pin.action}@${pin.sha.slice(0, 10)} says "# ${
        pin.comment
      }" but that sha is ` + `tagged ${tags.join(", ")}.`,
  };
}

/** Read every workflow file's pins. */
export function pinsIn(dir) {
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  return files.flatMap((f) => parsePins(readFileSync(join(dir, f), "utf8"), f));
}

function fetchTags(action) {
  const r = execFileSync("gh", ["api", `repos/${action}/tags?per_page=100`], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(r);
}

function main() {
  const pins = pinsIn(WORKFLOWS);
  if (pins.length === 0) {
    console.error(
      `COULD NOT COMPUTE: no sha-pinned actions found under .github/workflows.\n` +
        `      This asks whether pin comments resolve; with no pins there is nothing to ask it of.`
    );
    process.exit(2);
  }

  const actions = [...new Set(pins.map((p) => p.action))].sort();
  const maps = new Map();
  for (const a of actions) {
    let tags;
    try {
      tags = fetchTags(a);
    } catch (e) {
      // COULD NOT ASK, not answered no. A throttled or offline run must not report
      // every pin of this action as a mismatch — see #844.
      console.error(
        `COULD NOT COMPUTE: could not read tags for ${a}: ${String(
          e?.stderr ?? e?.message ?? e
        )
          .split("\n")[0]
          .slice(0, 160)}\n` +
          `      No pin of that action was checked. This is the absence of an answer about\n` +
          `      those comments, not a finding about them.`
      );
      process.exit(2);
    }
    maps.set(a, tagsBySha(tags));
  }

  const results = pins.map((p) => classifyPin(p, maps.get(p.action)));
  const unresolvable = results.filter((r) => r.kind === "unresolvable");
  const mismatches = results.filter((r) => r.kind === "mismatch");

  // REFUSAL OUTRANKS, per #689. A run that could not resolve some pins has not established
  // the property for them, and a partial answer is not an answer — but real mismatches found
  // alongside are still printed, because they are findings and they stand.
  if (mismatches.length > 0) {
    console.error(
      `FAIL: ${mismatches.length} pin comment(s) name a version their sha is not:`
    );
    for (const m of mismatches)
      console.error(`   - ${m.pin.file}:${m.pin.line}  ${m.why}`);
  }
  if (unresolvable.length > 0) {
    console.error(
      `COULD NOT CHECK: ${unresolvable.length} pin(s) whose sha is outside the tags window:`
    );
    for (const u of unresolvable)
      console.error(`   - ${u.pin.file}:${u.pin.line}  ${u.why}`);
    console.error(
      `\n      A pin older than the most recent 100 tags is unreadable by this check, not\n` +
        `      wrong. Resolve it by hand — \`gh api repos/<action>/commits/<sha>\` and the\n` +
        `      releases page — rather than editing a comment this run could not judge.` +
        (mismatches.length > 0
          ? `\n      The ${mismatches.length} mismatch(es) above ARE findings and stand.`
          : "")
    );
    process.exit(2);
  }
  if (mismatches.length > 0) process.exit(1);

  reportSubject(
    pins.length,
    "action pin comment(s) resolved against the tags API"
  );
  console.log(
    `PASS: every pin's comment names a tag that resolves to that pin's sha, across\n` +
      `      ${actions.length} action(s).`
  );
}

if (invokedAsProgram(import.meta.url)) main();
