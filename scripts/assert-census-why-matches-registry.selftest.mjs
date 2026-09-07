/**
 * PROOF for assert-census-why-matches-registry.mjs (#906).
 *
 * The comparison is a pure function over a census object and a registry object, so every arm is
 * driven from fabricated pairs rather than from a repository that happens to disagree. The
 * process-level arms — exit 1 on a contradiction, exit 2 on an unreadable input — are spawned
 * against planted trees via `--cwd`, because "could not ask" is a property of the process and a
 * refusal and a violation are the distinction this repo's exit codes exist to keep.
 *
 * THE HYPHEN CASE IS A REGRESSION, NOT A HYPOTHETICAL. The first draft matched the value
 * lazily before a dash class, and every declared value here is hyphenated — board-read,
 * merge-commit, action-tags. It captured `board`, read the hyphen inside the value as the
 * separator, and reported SEVEN contradictions that did not exist, each naming a real check
 * with a plausible message.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM,
  claimsFrom,
  registrationsFrom,
  contradictions,
} from "./assert-census-why-matches-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHECKER = join(HERE, "assert-census-why-matches-registry.mjs");
const DASH = "—";

const results = [];
const ok = (name, cond, detail) => results.push({ ok: !!cond, name, detail });

/** A tree carrying just the two files the checker reads. */
function plant({ checks, checkers, rawCensus }) {
  const dir = mkdtempSync(join(tmpdir(), "cwmr-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/checks.json"),
    JSON.stringify({ checks }, null, 2)
  );
  writeFileSync(
    join(dir, "scripts/eject-subject-census.json"),
    rawCensus ?? JSON.stringify({ checkers }, null, 2)
  );
  return dir;
}
const run = (dir) =>
  spawnSync(process.execPath, [CHECKER, "--cwd", dir], { encoding: "utf8" });
const why = (field, value) =>
  `declares ${field}:${value} ${DASH} its subject is read from outside the tree`;

/* ── CONTROL: the real repository, over a subject the output names ───────── */
{
  const r = spawnSync(process.execPath, [CHECKER], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const n = Number(/SUBJECT: (\d+)/.exec(r.stdout ?? "")?.[1] ?? 0);
  ok(
    "CONTROL: the real repo passes AND examines a non-empty subject",
    r.status === 0 && n > 0,
    `status=${r.status} subject=${n}`
  );
}

/* ── the parse ───────────────────────────────────────────────────────────── */
ok(
  "a hyphenated value is captured WHOLE — the seven-false-positives regression",
  CLAIM.exec(why("needs", "board-read"))?.[2] === "board-read",
  CLAIM.exec(why("needs", "board-read"))?.[2]
);
ok(
  "a reason that mentions the phrase MID-SENTENCE is not read as a claim",
  claimsFrom({
    checkers: {
      a: { why: `subject moved 3 -> 4, and it declares needs:x ${DASH} no` },
    },
  }).length === 0,
  "expected zero claims"
);
ok(
  "only rows whose reason quotes a registration are examined",
  JSON.stringify(
    claimsFrom({
      checkers: {
        a: { why: why("needs", "board-read") },
        b: { why: "subject unchanged at 12" },
        c: { why: why("subjectKind", "external") },
      },
    })
  ) ===
    JSON.stringify([
      { name: "a", field: "needs", value: "board-read" },
      { name: "c", field: "subjectKind", value: "external" },
    ]),
  JSON.stringify(
    claimsFrom({ checkers: { a: { why: why("needs", "board-read") } } })
  )
);

/* ── the comparison ──────────────────────────────────────────────────────── */
{
  const regs = registrationsFrom({
    checks: [{ name: "a", needs: "board-read" }],
  });
  ok(
    "an agreeing pair produces no complaint",
    contradictions([{ name: "a", field: "needs", value: "board-read" }], regs)
      .length === 0,
    "expected none"
  );
  ok(
    "a value the registry does not hold is caught, and the message names both sides",
    (() => {
      const p = contradictions(
        [{ name: "a", field: "needs", value: "repo-settings" }],
        regs
      );
      return (
        p.length === 1 && /repo-settings/.test(p[0]) && /board-read/.test(p[0])
      );
    })(),
    contradictions([{ name: "a", field: "needs", value: "x" }], regs)[0]
  );
  ok(
    "a field the registry declares NOTHING for is caught, and says so rather than printing undefined",
    (() => {
      const p = contradictions(
        [{ name: "a", field: "subjectKind", value: "external" }],
        regs
      );
      return p.length === 1 && /NOTHING for that field/.test(p[0]);
    })(),
    contradictions(
      [{ name: "a", field: "subjectKind", value: "external" }],
      regs
    )[0]
  );
  ok(
    "a census row naming a check that is NOT REGISTERED is caught",
    (() => {
      const p = contradictions(
        [{ name: "ghost", field: "needs", value: "board-read" }],
        regs
      );
      return p.length === 1 && /NOT REGISTERED/.test(p[0]);
    })(),
    contradictions([{ name: "ghost", field: "needs", value: "b" }], regs)[0]
  );
}

/* ── an empty set and an unreadable one must not be the same value ───────── */
ok(
  "a census with no `checkers` object THROWS rather than reporting zero claims",
  (() => {
    try {
      claimsFrom({ notCheckers: {} });
      return false;
    } catch (e) {
      return /no `checkers` object/.test(e.message);
    }
  })(),
  "expected a throw"
);
ok(
  "a registry with no `checks` array THROWS rather than making every claim unverifiable",
  (() => {
    try {
      registrationsFrom({ $comment: ["x"] });
      return false;
    } catch (e) {
      return /no `checks` array/.test(e.message);
    }
  })(),
  "expected a throw"
);

/* ── PLANT: the process-level arms ───────────────────────────────────────── */
{
  const dir = plant({
    checks: [{ name: "a", subjectKind: "tree" }],
    checkers: { a: { why: why("subjectKind", "external") } },
  });
  const r = run(dir);
  ok(
    "PLANT: a reason quoting `external` over a registry saying `tree` FAILS (exit 1)",
    r.status === 1 && /subjectKind/.test(r.stderr ?? ""),
    `status=${r.status} ${(r.stderr ?? "").slice(0, 120)}`
  );
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = plant({
    checks: [{ name: "a", needs: "board-read" }],
    checkers: { a: { why: why("needs", "board-read") } },
  });
  const r = run(dir);
  ok(
    "an agreeing tree passes (exit 0) — so the failure above is the contradiction, not the harness",
    r.status === 0,
    `status=${r.status} ${(r.stderr ?? "").slice(0, 120)}`
  );
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = plant({
    checks: [{ name: "a", needs: "board-read" }],
    rawCensus: "{ not json",
  });
  const r = run(dir);
  ok(
    "an unparseable census REFUSES (exit 2), not fails — could not ask is not answered no",
    r.status === 2 && /REFUSE/.test(r.stderr ?? ""),
    `status=${r.status}`
  );
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "cwmr-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/checks.json"),
    JSON.stringify({ $comment: ["no checks array"] })
  );
  writeFileSync(
    join(dir, "scripts/eject-subject-census.json"),
    JSON.stringify({ checkers: {} })
  );
  const r = run(dir);
  ok(
    "a registry with no `checks` array REFUSES (exit 2) rather than verifying nothing quietly",
    r.status === 2 && /REFUSE/.test(r.stderr ?? ""),
    `status=${r.status}`
  );
  rmSync(dir, { recursive: true, force: true });
}

/* ── report ─────────────────────────────────────────────────────────────── */
let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` ${DASH} ${r.detail}`}`
  );
}
const pass = results.filter((r) => r.ok).length;
const EXPECTED = 14; // 1 control + 3 parse + 4 comparison + 2 throws + 4 spawned

process.on("exit", (code) => {
  const ran = results.length;
  if (code === 0 && printed !== ran) {
    console.error(
      `\nFAIL: ${ran} case(s) ran and ${printed} printed ${DASH} ${
        ran - printed
      } INVISIBLE (#881).`
    );
    process.exitCode = 1;
  }
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `\nFAIL: ran ${ran} case(s), expected ${EXPECTED} ${DASH} a case was added or lost.`
    );
    process.exitCode = 1;
  }
});

if (pass !== results.length) {
  console.error(`\nFAIL: ${results.length - pass}/${results.length} wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${results.length}. A quoted declaration is compared to the declaration it\n` +
    `      quotes, a hyphenated value survives the parse, and an unreadable input refuses\n` +
    `      rather than reporting an empty claim set.`
);
