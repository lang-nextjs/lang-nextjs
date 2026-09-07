#!/usr/bin/env node
/**
 * Proves scripts/assert-single-instance.mjs can FAIL — do not remove.
 *
 * A checker nobody has watched fail is indistinguishable from a checker that
 * cannot fail, and the second reads as coverage while proving nothing. Every
 * case below plants one specific defect in a throwaway tree and asserts the
 * checker notices THAT defect, plus the vacuity guards that make its green mean
 * something.
 *
 * Case R1-DEP is the exact shape found in `packages/mcp` when this was
 * written — imports "zod", declares it in `dependencies` — and R2-SPLIT is the
 * exact zod 3.25.76 / 4.4.3 pair that shape produced.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SINGLETONS } from "./lib/singletons.mjs";

const CHECKER = join(process.cwd(), "scripts", "assert-single-instance.mjs");

/**
 * One version of every DECLARED singleton. Derived from the same array the
 * checker reads, so a name added to SINGLETONS cannot leave this fixture behind
 * — which would have been a fixture quietly covering one fewer module than the
 * checker claims. Pass overrides to give a module several versions.
 */
function fullLock(overrides = {}) {
  return SINGLETONS.flatMap((m) =>
    (overrides[m] ?? ["1.0.0"]).map((v) => `${m}@${v}`)
  );
}

function tree({ packages = {}, lock = fullLock() }) {
  const root = mkdtempSync(join(tmpdir(), "singleton-selftest-"));
  for (const [name, spec] of Object.entries(packages)) {
    const dir = join(root, "packages", name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(spec.manifest, null, 2)
    );
    writeFileSync(
      join(dir, "src", "index.ts"),
      spec.source ?? "export const x = 1;\n"
    );
  }
  if (lock !== null) {
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n" +
        lock
          .map((k) => `  ${k}:\n    resolution: {integrity: sha512-x}\n`)
          .join("") +
        "\nsnapshots:\n\n" +
        lock.map((k) => `  ${k}: {}\n`).join("")
    );
  }
  return root;
}

function run(root) {
  try {
    const out = execFileSync("node", [CHECKER], {
      cwd: root,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const peerPkg = {
  manifest: { name: "@x/peer", peerDependencies: { zod: "^4.0.0" } },
  source: 'import { z } from "zod";\nexport const s = z.string();\n',
};

const cases = [
  {
    name: "R1-DEP  imports zod, declares it in dependencies (the mcp shape)",
    tree: {
      packages: {
        bad: {
          manifest: { name: "@x/bad", dependencies: { zod: "^3.23.0" } },
          source: 'import { z } from "zod";\nexport const s = z.string();\n',
        },
      },
    },
    expect: (r) =>
      r.code === 1 && /R1 @x\/bad/.test(r.out) && /dependencies/.test(r.out),
  },
  {
    name: "R1-NONE imports zod, declares it nowhere (resolves by luck)",
    tree: {
      packages: {
        bad: {
          manifest: { name: "@x/bad" },
          source: 'import { z } from "zod";\nexport const s = z.string();\n',
        },
      },
    },
    expect: (r) => r.code === 1 && /declares it nowhere/.test(r.out),
  },
  {
    name: "R2-SPLIT lockfile holds two zod versions (the effect R1 alone misses)",
    tree: {
      packages: { ok: peerPkg },
      lock: fullLock({ zod: ["3.25.76", "4.4.3"] }),
    },
    expect: (r) =>
      r.code === 1 && /R2 "zod" resolves to 2 versions/.test(r.out),
  },
  {
    name: "R2-ONLY  manifests are clean but the tree is doubled by someone else",
    tree: {
      packages: { ok: peerPkg },
      lock: fullLock({ zod: ["4.4.3", "3.25.76"] }),
    },
    // The point of keeping R2 independent: R1 passes here and the tree is still broken.
    expect: (r) => r.code === 1 && !/R1 /.test(r.out) && /R2 /.test(r.out),
  },
  {
    name: "VACUOUS-0PKG   zero packages swept must REFUSE, not pass",
    tree: { packages: {} },
    expect: (r) => r.code === 2 && /swept 0 packages/.test(r.out),
  },
  {
    name: "VACUOUS-NOLOCK missing lockfile must REFUSE, not pass",
    tree: { packages: { ok: peerPkg }, lock: null },
    expect: (r) => r.code === 2 && /pnpm-lock\.yaml is absent/.test(r.out),
  },
  {
    name: "ABSENT   a declared singleton missing from the lockfile must REFUSE",
    // The defect this replaced: `if (!versions) continue` skipped it, so R2
    // counted what it FOUND. A misspelled entry checked one fewer module and the
    // PASS line was unchanged. Exit 2, not 1 — the subject shrank, so the
    // question could not be asked.
    tree: {
      packages: { ok: peerPkg },
      lock: fullLock().filter((k) => !k.startsWith("ai@")),
    },
    expect: (r) =>
      r.code === 2 && /absent from/.test(r.out) && /\bai\b/.test(r.out),
  },
  {
    name: "CLEAN    peer-declared and single-versioned passes",
    tree: { packages: { ok: peerPkg } },
    expect: (r) => r.code === 0 && /PASS/.test(r.out),
  },
];

let pass = 0;
for (const c of cases) {
  const root = tree(c.tree);
  const r = run(root);
  const ok = c.expect(r);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${c.name}`);
  if (!ok)
    console.log(
      `        exit=${r.code}\n        ${r.out
        .trim()
        .split("\n")
        .join("\n        ")}`
    );
  if (ok) pass++;
  rmSync(root, { recursive: true, force: true });
}

console.log(
  `\n${pass === cases.length ? "PASS" : "FAIL"}: ${pass}/${
    cases.length
  }. The checker refuses a\n` +
    `      hard dependency on a singleton, an undeclared one, a split lockfile, a\n` +
    `      clean-manifest/split-tree combination, a DECLARED SINGLETON MISSING FROM\n` +
    `      THE LOCKFILE, and both vacuous sweeps — so its green means single\n` +
    `      instances across the whole declared list rather than merely a green.`
);
process.exit(pass === cases.length ? 0 : 1);
