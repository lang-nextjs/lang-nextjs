#!/usr/bin/env node
/**
 * `pnpm build` — turbo, with its output-coverage warning turned into a FAILURE (#925).
 *
 * turbo caches a task by copying whatever its `outputs` globs match. A task whose globs
 * match NOTHING caches an EMPTY artifact, and the next cache hit "restores" that nothing
 * while skipping the build. Four apps shipped that way: `outputs` was `dist/**` while
 * they emit `.next/`, `build/` and `.svelte-kit/`, so a warm cache produced
 * `Could not find a production build` underneath a GREEN build step.
 *
 * THE SIGNAL IS INVERTED, WHICH IS WHY THIS EXISTS RATHER THAN A LINE IN A README.
 * turbo prints `no output files found for task X#build` only when the task EXECUTES — on
 * a COLD cache, the run where everything still works because the build really ran. On a
 * WARM cache the task is skipped, nothing is restored, the build is broken, and NO
 * warning is printed because nothing executed. The warning is present exactly when things
 * work and silent exactly when they break, so the defect has to be caught on the healthy
 * path. While investigating it, a zero-warning build was read as healthy three times,
 * once within the hour of writing that inversion down. A caveat does not survive that.
 *
 * ITS SUBJECT IS THE TURBO WORKSPACE AND NOTHING ELSE. `rungs/5-software-developer-agent`
 * carries its own yarn.lock and is not a workspace member, so turbo never sees it and
 * this says nothing about anything built in there.
 *
 * Exit 0 turbo succeeded and every executed task matched at least one output glob ·
 * 1 turbo failed, or a task cached nothing · 2 turbo could not be run at all.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The tasks turbo reported as matching no output glob, from a chunk of its output.
 *
 * ANSI IS STRIPPED BEFORE MATCHING and that is not tidiness: turbo colours these lines,
 * so a pattern written against the plain text silently misses the coloured one. That is
 * how a grep for `cache hit` came back empty during this investigation while the line was
 * on screen — an ANSI reset sits between the task name and the words.
 */
export function starvedTasks(text) {
  const plain = String(text).split(ANSI).join("");
  const out = new Set();
  for (const m of plain.matchAll(/no output files found for task (\S+)/g))
    out.add(m[1].replace(/[.,]$/, ""));
  return out;
}

/*
 * GUARDED, BECAUSE THIS MODULE SPAWNS A BUILD. Without it, importing the file to test
 * `starvedTasks` runs the WHOLE WORKSPACE BUILD as an import side effect — which is what
 * happened the first time, 36KB of turbo output from what should have been a unit test.
 */
function main() {
  /*
   * RESOLVED FROM node_modules/.bin RATHER THAN PATH. `pnpm run` puts that directory on
   * PATH, so `spawn("turbo")` works under `pnpm build` and ENOENTs under every other
   * invocation — including a proof that runs this file directly. A guard that works only
   * when launched one particular way has an arm nobody can test.
   */
  const local = join(ROOT, "node_modules", ".bin", "turbo");
  const bin = existsSync(local) ? local : "turbo";
  const child = spawn(bin, ["run", "build", ...process.argv.slice(2)], {
    stdio: ["inherit", "pipe", "pipe"],
  });

  /*
   * A MISSING BINARY IS "COULD NOT ASK", NOT "THE BUILD FAILED". Without this the ENOENT
   * arrives as an unhandled `error` event: node prints a stack trace and exits 1, which
   * is indistinguishable to anything reading the exit code from a real build failure.
   */
  child.on("error", (err) => {
    console.error(
      err?.code === "ENOENT"
        ? `REFUSE: turbo was not found at ${local} and is not on PATH. Nothing was ` +
            `built, so nothing is known about output coverage. Run \`pnpm install\`.`
        : `REFUSE: turbo could not be started: ${err?.message}`
    );
    process.exit(2);
  });

  const starved = new Set();
  const watch = (stream, sink) => {
    stream.on("data", (buf) => {
      sink.write(buf);
      for (const t of starvedTasks(buf)) starved.add(t);
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);

  child.on("close", (code, signal) => {
    if (signal) {
      console.error(`\nbuild: turbo was killed by ${signal}.`);
      process.exit(1);
    }
    if (code !== 0) process.exit(code ?? 1);
    if (starved.size === 0) return;
    console.error(
      `\nFAIL: ${starved.size} build task(s) matched NO output glob, so turbo cached an\n` +
        `      EMPTY artifact for each:\n` +
        [...starved].map((t) => `        ${t}`).join("\n") +
        `\n\n      THIS run is fine — those tasks executed. The next run that HITS the\n` +
        `      cache will skip the build, restore nothing, and report success while\n` +
        `      leaving no build on disk. Add the emitted directory to \`outputs\` in\n` +
        `      turbo.json. turbo prints its warning only when a task RUNS, so a cold run\n` +
        `      like this one is the only run on which the defect is visible at all.`
    );
    process.exit(1);
  });
}

if (invokedAsProgram(import.meta.url)) main();
