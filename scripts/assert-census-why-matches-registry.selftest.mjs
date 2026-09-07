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
  mustClaim,
  silentObligations,
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
/*
 * A REASON THAT ANNOUNCES A CLAIM AND DOES NOT PARSE. Skipping it silently narrows the subject
 * by one, and the vacuity floor of 1 cannot see that — it only fires when EVERY row stops
 * parsing. The likelier edit is a PARTIAL wording change in eject-classify.mjs, which takes the
 * claim set from 8 to 7 with nothing saying so.
 */
ok(
  "a `why` that begins `declares ` but does not parse THROWS, naming the row and the text",
  (() => {
    try {
      claimsFrom({
        checkers: {
          a: { why: `declares needs=board-read ${DASH} wrong separator` },
        },
      });
      return false;
    } catch (e) {
      return (
        /^a: /.test(e.message) &&
        /does not parse/.test(e.message) &&
        /wrong separator/.test(e.message)
      );
    }
  })(),
  "expected a throw naming the row"
);

{
  const dir = plant({
    checks: [{ name: "a", needs: "board-read" }],
    checkers: {
      a: { why: `declares needs=board-read ${DASH} wrong separator` },
    },
  });
  const r = run(dir);
  ok(
    "...and end to end it REFUSES (exit 2), not fails — an unparsed claim was never asked, not answered no",
    r.status === 2 && /REFUSE/.test(r.stderr ?? ""),
    `status=${r.status} ${(r.stderr ?? "").slice(0, 120)}`
  );
  rmSync(dir, { recursive: true, force: true });
}

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

/* ── the obligation half: a registration owing a claim must have one ───────── */
ok(
  "mustClaim is the UNION of needs and external, so it needs no branch order",
  JSON.stringify(
    [
      ...mustClaim({
        checks: [
          { name: "chan", needs: "board-read" },
          { name: "ext", subjectKind: "external" },
          { name: "both", needs: "board-read", subjectKind: "external" },
          { name: "plain" },
        ],
      }),
    ].sort()
  ) === JSON.stringify(["both", "chan", "ext"]),
  [...mustClaim({ checks: [{ name: "chan", needs: "x" }] })]
);
ok(
  "a registration obliged to claim, with the census silent, is caught",
  (() => {
    const p = silentObligations(new Set(["a", "b"]), [
      { name: "a", field: "needs", value: "board-read" },
    ]);
    return (
      p.length === 1 && /^b: /.test(p[0]) && /census carries none/.test(p[0])
    );
  })(),
  silentObligations(new Set(["a", "b"]), [{ name: "a" }])
);
ok(
  "every obligation met produces no complaint",
  silentObligations(new Set(["a"]), [{ name: "a", field: "needs", value: "x" }])
    .length === 0,
  "expected none"
);
ok(
  "mustClaim THROWS on a registry with no `checks` array rather than obliging nobody",
  (() => {
    try {
      mustClaim({ $comment: [] });
      return false;
    } catch (e) {
      return /no `checks` array/.test(e.message);
    }
  })(),
  "expected a throw"
);

{
  /*
   * THE DOOR THIS CLOSES. #906's refusal only fires on a `why` that still BEGINS
   * `declares `. Reword the leading verb and there is nothing for it to catch — the row
   * simply stops being a claim. The obligation half sees the silence instead.
   */
  const dir = plant({
    checks: [{ name: "a", needs: "board-read" }],
    checkers: {
      a: { why: `states needs:board-read ${DASH} reworded leading verb` },
    },
  });
  const r = run(dir);
  ok(
    "PLANT: a reworded leading verb leaves the row silent, and the obligation half FAILS (exit 1)",
    r.status === 1 && /census carries none/.test(r.stderr ?? ""),
    `status=${r.status} ${(r.stderr ?? "").slice(0, 120)}`
  );
  rmSync(dir, { recursive: true, force: true });
}

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
const EXPECTED = 21; // 1 control + 3 parse + 4 comparison + 3 throws + 5 spawned

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
  `\nPASS: ${pass}/${results.length}. Every claim present quotes its registration, every\n` +
    `      registration owing a claim has one, a hyphenated value survives the parse, and\n` +
    `      an unreadable input refuses rather than reporting an empty claim set.`
);
