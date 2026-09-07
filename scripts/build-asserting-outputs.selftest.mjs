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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  existsSync,
} from "node:fs";
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

/* ── the PINNED turbo still SAYS the thing this parser matches (#946) ──────── */
/*
 * EVERY ARM ABOVE IS FABRICATED TEXT, AND THAT PROVES THE PARSE AND NOT THE PREMISE. The
 * pattern is a claim about ANOTHER PROGRAM'S WORDING, and a rewording makes it match nothing --
 * which is byte-for-byte what passing looks like. The guard would exit 0 forever while reading
 * as armed in checks.json and in CI.
 *
 * SO THE TOOL IS EXERCISED RATHER THAN QUOTED. A throwaway workspace with one deliberately
 * starved task is built in a temp directory and the REPOSITORY'S OWN PINNED turbo is run against
 * it. This is not the machine-dependence trap: a font stack varies by machine and must be
 * injected, because the machine is not the subject; turbo's wording varies by VERSION and this
 * repo RESOLVES ONE VERSION REPRODUCIBLY, so exercising it is a fact about a dependency under
 * this repo's control.
 *
 * AND THE PIN IS NOT WHERE IT LOOKS. `package.json` says `"turbo": "^2.10.12"`, which is a
 * RANGE; what fixes the version is `pnpm-lock.yaml` at `turbo@2.10.12` plus CI's
 * `--frozen-lockfile`. So the claim above is true by a different mechanism than "the manifest
 * pins it", and a resolution outside the lockfile would move the wording under this arm without
 * changing a manifest line. That is why the version MEASURED is printed in the arm's name
 * rather than assumed from the manifest: whatever binary ran, the reader is told which one the
 * verdict is about.
 *
 * THOSE TWO FIGURES WERE 2.9.16 UNTIL #806 BUMPED THEM, WHICH IS THE POINT ARRIVING IN THE
 * PARAGRAPH THAT MAKES IT. A measured version in prose expires exactly like a measured count,
 * and this one expired inside the sentence explaining why versions must be measured. The arm
 * itself did not expire, because it reads the binary rather than the manifest.
 *
 * AND THE BUMP IS THE FIRST REAL TEST THIS ARM HAS HAD. Every mutation above is fabricated --
 * the pattern and the fixtures rewritten together -- which shows the arm CAN fail and nothing
 * about whether the tool moves. #806 moved it. Run against 2.10.12 before the bump landed here:
 * the phrase is unchanged, the fixture still starves on disk, and `starvedTasks` returns exactly
 * `["starved#build"]`. So the wording claim has now survived a real minor bump, which is a
 * stronger thing to know than any number of mutations.
 *
 * `--force` FORECLOSES A CACHE HIT RATHER THAN PREVENTING ONE. turbo prints this warning only
 * when a task EXECUTES, so a cache hit would produce no phrase and the arm would fail for a
 * reason unrelated to wording -- the inversion the checker's own header is about. But a hit is
 * NOT REACHABLE here today, measured rather than assumed (DEV2): `elsewhere/f.txt` falls outside
 * the declared `outputs`, so it counts as an INPUT and the hash moves every run -- two
 * consecutive runs without the flag both report `cache miss, executing`, with the warning
 * present on both -- and `mkdtempSync` hands out a fresh fixture regardless. The flag is kept
 * because it costs nothing and closes the case if turbo's hashing or this fixture ever changes.
 *
 * THE CORRECTION IS THE SENTENCE, NOT THE FLAG, and it is worth the line because this arm's
 * whole subject is that a claim about another program's behaviour must be EXERCISED rather than
 * asserted -- and the paragraph above asserted one about that same program's caching.
 *
 * AND THE FIXTURE CARRIES ITS OWN CONTROL. `fed` emits into the declared `outputs` glob and
 * `starved` does not, so ONE run answers both questions: the phrase is found for the task that
 * starved, and NOT for the one that did not.
 *
 * THE CONTROL COVERS ONE NAMESPACE, AND SAYING WHICH IS THE POINT (DEV2). It discriminates
 * against a parse keyed on turbo's LOG PREFIX -- `/(\S+:build)/` finds `fed:build` and
 * `starved:build`, so that parse fails this arm. It does NOT discriminate in the `#` namespace:
 * measured on turbo's real output, `starved#` appears once and `fed#` appears ZERO times,
 * because the `pkg#task` form exists only inside the warning line. So `/(\S+#build)/` matches
 * "everything" it can see and still yields the right answer -- this fixture cannot produce a
 * `fed#build` token for it to be wrong about. The arm is real and it is not a general
 * over-match control.
 */
{
  const turbo = resolve(HERE, "..", "node_modules", ".bin", "turbo");
  const fixture = mkdtempSync(join(tmpdir(), "bao-wording-"));
  const emit = (where) =>
    `node -e "require('fs').mkdirSync('${where}',{recursive:true});require('fs').writeFileSync('${where}/f.txt','x')"`;
  const pkg = (dir, json) => {
    mkdirSync(join(fixture, dir), { recursive: true });
    writeFileSync(join(fixture, dir, "package.json"), JSON.stringify(json));
  };
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "turbo-wording-fixture",
      private: true,
      packageManager: "pnpm@9.0.0",
    })
  );
  writeFileSync(
    join(fixture, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n'
  );
  writeFileSync(
    join(fixture, "turbo.json"),
    JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } })
  );
  pkg("packages/starved", {
    name: "starved",
    version: "0.0.0",
    scripts: { build: emit("elsewhere") },
  });
  pkg("packages/fed", {
    name: "fed",
    version: "0.0.0",
    scripts: { build: emit("dist") },
  });

  /*
   * THE PROBE RUNS IN THE FIXTURE, NOT THE AMBIENT CWD, AND THAT IS NOT TIDINESS. `turbo`
   * RE-EXECS into a repo-local install based on where it is invoked, so `--version` answers
   * about the CWD's repository rather than about the binary you handed it. Measured: one
   * binary, three directories --
   *
   *     cwd = a checkout whose node_modules holds 2.9.16   ->  2.9.16
   *     cwd = a directory with no local turbo              ->  2.10.12
   *
   * -- so a probe taken in the ambient cwd can LABEL this arm with a different turbo than the
   * one that produced its verdict. Sharing the fixture's cwd with the run makes the printed
   * version the version under test.
   */
  const version = (
    spawnSync(turbo, ["--version"], { encoding: "utf8", cwd: fixture })
      .stdout ?? ""
  ).trim();
  const r = spawnSync(turbo, ["run", "build", "--force"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 180000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const found = starvedTasks(out);
  /*
   * THE DISCRIMINATOR, MEASURED ON DISK RATHER THAN IN THE OUTPUT. If no phrase is found there
   * are TWO causes needing opposite responses -- turbo reworded it, or the fixture stopped
   * starving -- and turbo's own output cannot separate them, because the absence of the line is
   * the symptom in both. So starvation is established from the FILES: `starved` must have
   * emitted OUTSIDE the declared `outputs` glob and `fed` INSIDE it. That holds or fails
   * whatever turbo prints, which is what makes the arm below able to name the wording.
   */
  const wrote = (p) => existsSync(join(fixture, "packages", p));
  ok(
    `the fixture really starves under turbo ${
      version || "(version unreadable)"
    } — measured on disk, not in the log`,
    r.status === 0 &&
      /starved:build/.test(out) &&
      /fed:build/.test(out) &&
      wrote("starved/elsewhere/f.txt") &&
      !wrote("starved/dist") &&
      wrote("fed/dist/f.txt"),
    `status=${r.status} starved-outside=${wrote(
      "starved/elsewhere/f.txt"
    )} starved-dist=${wrote("starved/dist")} fed-dist=${wrote(
      "fed/dist/f.txt"
    )} ${out.slice(0, 160)}`
  );
  ok(
    "...and turbo's CURRENT wording is still something starvedTasks matches — a rewording is red here, not silently green",
    found.has("starved#build"),
    `turbo ${version} ran and reported ${JSON.stringify([
      ...found,
    ])}. The arm above establishes the fixture starved on DISK, so if it passed, this is turbo's WORDING: read its real output and update the pattern in build-asserting-outputs.mjs.`
  );
  ok(
    "...and the WELL-FED task is not reported, so the match is about starvation and not about running",
    !found.has("fed#build") && found.size === 1,
    [...found]
  );
  rmSync(fixture, { recursive: true, force: true });
}

let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`
  );
}
const pass = results.filter((r) => r.ok).length;
const EXPECTED = 11;
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
    `      INSIDE the phrase is stripped, importing the module builds nothing, a missing\n` +
    `      turbo refuses rather than failing, and THE RESOLVED TURBO WAS RUN against a\n` +
    `      starved fixture — so the pattern is exercised against the tool rather than\n` +
    `      quoted from it.`
);
