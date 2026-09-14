#!/usr/bin/env node
/**
 * PROOF FOR probe-model-ids.mjs — it can find a retired id, it refuses what it cannot ask, and it
 * does not count ids nobody is offered (#1174).
 *
 * EVERY OUTCOME IS DRIVEN, none is asserted about source. `probe()` takes `env` and `fetchImpl`,
 * so a missing credential, a catalogue that 404s, an empty catalogue and a retired id are all real
 * paths through the real code here — not fixtures describing what it would do.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  offeredIds,
  askProvider,
  probe,
  renderAndRank,
  MODELS_FILE,
} from "./probe-model-ids.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (label, cond, note) => {
  if (cond) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(`  FAIL ${label}\n       ${JSON.stringify(note)}`);
    fail++;
  }
};
const res = (body, init = {}) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
});
const catalogue =
  (...ids) =>
  () =>
    res({ data: ids.map((id) => ({ id })) });

console.log("\nprobe-model-ids.mjs self-test\n");

/* ── the menu is parsed, and a COMMENT IS NOT AN OFFER ────────────────────────────────── */
{
  const src = [
    '  { label: "Live", value: "anthropic:claude-live" },',
    '  // { label: "Parked", value: "anthropic:claude-parked" },',
    '    //   value: "openai:gpt-parked",',
  ].join("\n");
  const got = offeredIds(src);
  ok(
    "an offered id is parsed and a commented-out one is NOT",
    got.length === 1 && got[0] === "anthropic:claude-live",
    got
  );
  const real = offeredIds(readFileSync(join(ROOT, MODELS_FILE), "utf8"));
  ok(
    "CONTROL: the parse finds ids in the REAL menu, so an empty result would be a defect not a clean tree",
    real.length > 5,
    real.length
  );
  ok(
    "...and the real menu's commented-out extended-thinking ids are excluded (#1174's body counts them, its title does not)",
    !real.some((id) => id.includes("extended-thinking")),
    real.filter((id) => id.includes("extended-thinking"))
  );
}

/* ── the three per-provider outcomes, each driven ─────────────────────────────────────── */
{
  const wanted = ["anthropic:claude-a", "anthropic:claude-b"];
  const holds = await askProvider("anthropic", wanted, {
    env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: catalogue("claude-a", "claude-b"),
  });
  ok(
    "HOLDS: every offered id is in the catalogue -> 0",
    holds.status === 0,
    holds
  );

  const violated = await askProvider("anthropic", wanted, {
    env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: catalogue("claude-a"),
  });
  ok(
    "VIOLATED: a retired id is found and NAMED -> 1",
    violated.status === 1 && violated.missing?.[0] === "anthropic:claude-b",
    violated
  );

  const noKey = await askProvider("anthropic", wanted, {
    env: {},
    fetchImpl: catalogue("claude-a"),
  });
  ok(
    "COULD NOT ASK: no credential -> 2, and it is not a pass",
    noKey.status === 2,
    noKey
  );

  const http = await askProvider("anthropic", wanted, {
    env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: () => res({}, { ok: false, status: 503 }),
  });
  ok("COULD NOT ASK: the catalogue answered 503 -> 2", http.status === 2, http);

  const empty = await askProvider("anthropic", wanted, {
    env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: catalogue(),
  });
  ok(
    "COULD NOT ASK: an EMPTY catalogue is not an answer -> 2, not a silent pass over nothing",
    empty.status === 2,
    empty
  );
}

/* ── the run's exit code, which is not the worst provider status ──────────────────────── */
{
  const all2 = renderAndRank({
    subjectAbsent: false,
    path: "x",
    offered: ["a:1", "b:2"],
    providers: {
      a: { status: 2, why: "no key", wanted: ["a:1"] },
      b: { status: 2, why: "no key", wanted: ["b:2"] },
    },
  });
  ok(
    "NOTHING asked -> exit 2, and the text says the run measured nothing",
    all2.code === 2 && /measured nothing/.test(all2.out),
    all2.out.slice(0, 80)
  );

  const mixed = renderAndRank({
    subjectAbsent: false,
    path: "x",
    offered: ["a:1", "b:2", "b:3"],
    providers: {
      a: { status: 0, why: "ok", wanted: ["a:1"] },
      b: { status: 2, why: "no key", wanted: ["b:2", "b:3"] },
    },
  });
  ok(
    "ONE answered and others unaskable -> exit 0, and the COUNTS are stated (today's shape)",
    mixed.code === 0 &&
      /1 checked against a provider catalogue, 2 unaskable/.test(mixed.out),
    mixed.out.split("\n")[0]
  );

  const bad = renderAndRank({
    subjectAbsent: false,
    path: "x",
    offered: ["a:1"],
    providers: {
      a: { status: 1, why: "missing", wanted: ["a:1"], missing: ["a:1"] },
    },
  });
  ok(
    "a VIOLATION outranks unaskable providers -> exit 1",
    bad.code === 1 && /MISSING: a:1/.test(bad.out),
    bad.out.slice(0, 80)
  );
}

/* ── a subject that is legitimately absent ────────────────────────────────────────────── */
{
  const absent = await probe({
    cwd: "/nonexistent-tree",
    env: {},
    fetchImpl: catalogue("x"),
  });
  const rendered = renderAndRank(absent);
  ok(
    "rung 5 absent -> exit 0 and SAYS SO, rather than reading as present-and-unchecked",
    absent.subjectAbsent === true &&
      rendered.code === 0 &&
      /SUBJECT ABSENT/.test(rendered.out),
    rendered.out.slice(0, 80)
  );
}

/* ── end to end over the real menu, with one provider answering ───────────────────────── */
{
  const real = await probe({
    cwd: ROOT,
    env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: catalogue(
      "claude-sonnet-4-0",
      "claude-opus-4-1",
      "claude-opus-4-0",
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest"
    ),
  });
  const rendered = renderAndRank(real);
  ok(
    "END TO END: with only an anthropic key, anthropic HOLDS and the other two are unaskable",
    real.providers.anthropic.status === 0 &&
      real.providers.openai.status === 2 &&
      real.providers["google-genai"].status === 2,
    Object.fromEntries(
      Object.entries(real.providers).map(([k, v]) => [k, v.status])
    )
  );
  ok(
    "...and the run exits 0 while REPORTING how many were unaskable",
    rendered.code === 0 && /unaskable/.test(rendered.out),
    rendered.out.split("\n")[0]
  );
}

/* ── an EMPTY offered set is refused, not passed over ─────────────────────────────────── */
{
  const empty = renderAndRank({
    subjectAbsent: false,
    path: "x",
    offered: [],
    providers: {},
  });
  ok(
    "an OFFERED set that parsed to zero is REFUSED (exit 2), not ranked 0 over nothing",
    empty.code === 2 && /parsed to ZERO offered ids/.test(empty.out),
    empty
  );
}

/*
 * THE COUNT IS DECLARED ABOVE THE HANDLER (#1122), and that placement is not style: a `const`
 * still in its temporal dead zone when the exit handler runs throws THERE, and the failure
 * presents as "nothing printed" — the worst symptom for a diagnostic whose whole job is making
 * loss visible. DEV1 hit exactly that taking this repair on #1290.
 */
const EXPECTED = 15;

/*
 * THE VERDICT RUNS FROM AN EXIT HOOK, so an arm appended below it still counts. An arm that runs
 * and is not counted contributes nothing while the banner stays green — and the banner this file
 * used to print was `${pass}/${pass}`, the count divided by itself, which reads 14/14 whatever was
 * lost. It now compares against a declared constant.
 *
 * AND THE MISMATCH IS REPORTED EVEN WHEN AN ARM ALSO FAILED. Gating it on `code === 0` would skip
 * the report in exactly the state where a case was lost alongside a real failure — DEV1's own
 * defect on #1290, found by the worked example this checker names.
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  const lost = ran !== EXPECTED;
  const lostLine =
    `ran ${ran} case(s), expected ${EXPECTED} — a case was added or lost. Arms below the ` +
    `verdict are NOT inert: every result is counted at exit, so if the new arms pass, update ` +
    `the constant.`;

  if (fail !== 0) {
    console.error(
      `FAIL: ${fail}/${ran} cases wrong.${
        lost ? `\n      AND ${lostLine}` : ""
      }`
    );
    process.exitCode = 1;
    return;
  }
  if (lost) {
    console.error(`FAIL: ${lostLine}`);
    process.exitCode = 1;
    return;
  }
  if (code !== 0) return;
  console.log(
    `\nPASS: ${ran}/${EXPECTED}. The probe finds a retired id and names it, refuses a missing\n` +
      `      credential, a 503 and an empty catalogue rather than passing over them, excludes\n` +
      `      commented-out ids, refuses an EMPTY offered set rather than passing vacuously, says\n` +
      `      when rung 5 is absent, and reports checked-versus-unaskable on every run.`
  );
});
