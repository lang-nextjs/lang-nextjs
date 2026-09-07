/**
 * PROOF for build-asserting-outputs.mjs (#925).
 *
 * The parse is a pure function over a chunk of turbo output, so every arm is driven from
 * fabricated text rather than from a build that happens to be in the right state. The two
 * process-level arms — a missing binary refusing, and the module doing NOTHING on import —
 * are spawned, because both are properties of the process rather than of the parse.
 *
 * THE COLOURED CASE IS A REGRESSION, NOT A HYPOTHETICAL. During this investigation a grep
 * for `cache hit` returned empty while the line was on screen, because turbo puts an ANSI
 * reset between the task name and the words. A pattern written against plain text passes
 * every hand-written fixture and misses every real line.
 *
 * THE IMPORT CASE IS ALSO A REGRESSION. The first version spawned turbo at module scope,
 * so importing it to test the parse ran the whole workspace build — 36KB of turbo output
 * from what should have been a unit test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { starvedTasks } from "./build-asserting-outputs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "build-asserting-outputs.mjs");
const E = String.fromCharCode(27);
const results = [];
const ok = (name, cond, detail) => results.push({ ok: !!cond, name, detail });

const WARN =
  "no output files found for task example#build. Please check your `outputs`";

ok(
  "finds a starved task in plain output",
  [...starvedTasks(WARN)].join() === "example#build",
  [...starvedTasks(WARN)]
);
ok(
  "the form turbo emits today: escapes WRAP the phrase, so the token is reached either way",
  [
    ...starvedTasks(`${E}[33;40m WARNING ${E}[0m ${E}[33;49m${WARN}${E}[0m`),
  ].join() === "example#build",
  [...starvedTasks(`${E}[33m${WARN}${E}[0m`)]
);
/*
 * THE CASE ABOVE DOES NOT EXERCISE THE STRIP, AND SAYING SO IS THE POINT. turbo wraps this
 * line's escapes AROUND the phrase — verified against captured output — so nothing falls
 * between `task` and the token and the pattern matches with or without stripping. Removing
 * the strip left the proof at 7/7, which is how a green asserts less than its name.
 *
 * The case below is what makes the strip load-bearing, and it is DEFENSIVE: turbo does not
 * emit this form today. Without the strip the pattern misses entirely.
 */
ok(
  "an escape INSIDE the phrase is stripped — defensive, and the case that makes the strip bite",
  [
    ...starvedTasks(`no output files${E}[0m found for task example#build.`),
  ].join() === "example#build",
  [...starvedTasks(`no output files${E}[0m found for task example#build.`)]
);
ok(
  "a clean run yields nothing, so a pass is not manufactured by the parse",
  starvedTasks("Tasks: 5 successful, 5 total\nCached: 5 cached, 5 total")
    .size === 0,
  "expected empty"
);
ok(
  "the same task warned twice counts once",
  starvedTasks(WARN + "\n" + WARN).size === 1,
  starvedTasks(WARN + "\n" + WARN).size
);
ok(
  "several starved tasks are all reported, not just the first",
  starvedTasks(
    "no output files found for task a#build.\nno output files found for task b#build."
  ).size === 2,
  [
    ...starvedTasks(
      "no output files found for task a#build.\nno output files found for task b#build."
    ),
  ]
);

/* ── the module must not act on import ─────────────────────────────────────── */
{
  const probe = mkdtempSync(join(tmpdir(), "bao-"));
  const f = join(probe, "p.mjs");
  writeFileSync(
    f,
    `import ${JSON.stringify(SCRIPT)}; console.log("IMPORTED");\n`
  );
  const r = spawnSync(process.execPath, [f], {
    encoding: "utf8",
    timeout: 60000,
  });
  ok(
    "importing the module runs NO build — it is guarded, not a top-level spawn",
    /IMPORTED/.test(r.stdout ?? "") &&
      !/turbo|Packages in scope/.test((r.stdout ?? "") + (r.stderr ?? "")),
    ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 100)
  );
  rmSync(probe, { recursive: true, force: true });
}

/* ── a missing turbo is a REFUSAL, not a build failure ─────────────────────── */
{
  const bare = mkdtempSync(join(tmpdir(), "bao-noturbo-"));
  mkdirSync(join(bare, "scripts"), { recursive: true });
  cpSync(SCRIPT, join(bare, "scripts", "build-asserting-outputs.mjs"));
  cpSync(
    join(HERE, "lib", "is-main.mjs"),
    join(bare, "scripts", "lib", "is-main.mjs"),
    {
      recursive: true,
    }
  );
  const r = spawnSync(
    process.execPath,
    [join(bare, "scripts", "build-asserting-outputs.mjs")],
    /*
     * PATH IS EMPTIED, NOT INHERITED. The bare directory removes the LOCAL
     * node_modules/.bin/turbo, but the `"turbo"` fallback still resolves through an
     * inherited PATH — so on a machine with turbo installed globally this arm would run a
     * real build in a temp directory and pass for the wrong reason. It is isolated here
     * only because `command -v turbo` happens to be empty.
     */
    {
      cwd: bare,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PATH: "" },
    }
  );
  ok(
    "a missing turbo REFUSES (exit 2) rather than failing (1) — could not ask is not answered no",
    r.status === 2 && /REFUSE/.test(r.stderr ?? ""),
    `status=${r.status} ${(r.stderr ?? "").slice(0, 90)}`
  );
  rmSync(bare, { recursive: true, force: true });
}

let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`
  );
}
const pass = results.filter((r) => r.ok).length;
const EXPECTED = 8;
process.on("exit", (code) => {
  if (code === 0 && printed !== results.length) {
    console.error(
      `\nFAIL: ${results.length} ran and ${printed} printed — INVISIBLE (#881).`
    );
    process.exitCode = 1;
  }
  if (code === 0 && results.length !== EXPECTED) {
    console.error(
      `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.`
    );
    process.exitCode = 1;
  }
});
if (pass !== results.length) {
  console.error(`\nFAIL: ${results.length - pass}/${results.length} wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${results.length}. The form turbo emits today is matched, an escape\n` +
    `      INSIDE the phrase is stripped, importing the module builds nothing, and a\n` +
    `      missing turbo refuses rather than failing.`
);
