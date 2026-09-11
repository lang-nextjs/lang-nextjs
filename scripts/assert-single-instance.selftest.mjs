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

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
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
      // `raw` plants a manifest JSON.stringify could never produce — e.g. the
      // merge-conflict markers an ordinary rebase leaves behind (#1215).
      spec.raw ?? JSON.stringify(spec.manifest, null, 2)
    );
    writeFileSync(
      join(dir, "src", "index.ts"),
      spec.source ?? "export const x = 1;\n"
    );
    for (const [f, content] of Object.entries(spec.sources ?? {}))
      writeFileSync(join(dir, "src", f), content);
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
    // #1215's measured row for this checker. `read()` was a bare JSON.parse, so
    // the conflict markers an ordinary rebase leaves in a manifest THREW at zz —
    // after aa's R1 failure was computed (aa sorts first), before it printed at
    // :204. The run exited 1 on a Node trailer, run-checks filed it `refused`,
    // and the finding was named 0 times. Both must now print, and the finding
    // decides the exit.
    name: "PARSE-ARM  an unparseable manifest beside an R1 failure shows BOTH, exit 1",
    tree: {
      packages: {
        aa: {
          manifest: { name: "@x/aa", dependencies: { zod: "^3.23.0" } },
          source: 'import { z } from "zod";\nexport const s = z.string();\n',
        },
        zz: {
          raw: '{\n  "name": "@x/zz",\n<<<<<<< HEAD\n  "version": "1.0.0"\n=======\n  "version": "1.1.0"\n>>>>>>> branch\n}\n',
        },
      },
    },
    expect: (r) =>
      r.code === 1 &&
      /R1 @x\/aa/.test(r.out) &&
      /packages\/zz\/package\.json/.test(r.out) &&
      !/SyntaxError/.test(r.out),
  },
  {
    // The same refusal with nothing computed beside it stays could-not-compute.
    name: "PARSE-CONTROL  an unparseable manifest alone REFUSES, naming the file",
    tree: {
      packages: {
        zz: { raw: '{\n<<<<<<< HEAD\n  "name": "@x/zz"\n}\n' },
      },
    },
    expect: (r) =>
      r.code === 2 &&
      /packages\/zz\/package\.json/.test(r.out) &&
      !/FAIL/.test(r.out) &&
      !/SyntaxError/.test(r.out),
  },
  {
    // Same crash class as the manifest row, one read over (#1215): importsModule's
    // per-file readFileSync was unguarded, so a chmod-000 source file threw out of
    // the walk after earlier packages' failures had accumulated. deep.ts WOULD
    // match the zod import — the import exists and cannot be seen.
    name: "SRC-ARM  an unreadable source file beside an R1 failure shows BOTH, exit 1",
    tree: {
      packages: {
        aa: {
          manifest: { name: "@x/aa", dependencies: { zod: "^3.23.0" } },
          source: 'import { z } from "zod";\nexport const s = z.string();\n',
        },
        zz: {
          manifest: { name: "@x/zz" },
          sources: {
            "deep.ts": 'import { z } from "zod";\nexport const d = z;\n',
          },
        },
      },
    },
    after: (root) =>
      chmodSync(join(root, "packages", "zz", "src", "deep.ts"), 0o000),
    expect: (r) =>
      r.code === 1 &&
      /R1 @x\/aa/.test(r.out) &&
      /packages\/zz\/src\/deep\.ts/.test(r.out) &&
      !/Node\.js v/.test(r.out),
  },
  {
    name: "SRC-CONTROL  an unreadable source file alone REFUSES, naming the file",
    tree: {
      packages: {
        zz: {
          manifest: { name: "@x/zz" },
          sources: {
            "deep.ts": 'import { z } from "zod";\nexport const d = z;\n',
          },
        },
      },
    },
    after: (root) =>
      chmodSync(join(root, "packages", "zz", "src", "deep.ts"), 0o000),
    expect: (r) =>
      r.code === 2 &&
      /packages\/zz\/src\/deep\.ts/.test(r.out) &&
      !/FAIL/.test(r.out) &&
      !/Node\.js v/.test(r.out),
  },
  {
    // The lockfile read was guarded by existsSync only: present but unreadable
    // (or deleted between the check and the read) threw after the R1 loop.
    name: "LOCK-ARM  an unreadable lockfile beside an R1 failure shows BOTH, exit 1",
    tree: {
      packages: {
        aa: {
          manifest: { name: "@x/aa", dependencies: { zod: "^3.23.0" } },
          source: 'import { z } from "zod";\nexport const s = z.string();\n',
        },
      },
    },
    after: (root) => chmodSync(join(root, "pnpm-lock.yaml"), 0o000),
    expect: (r) =>
      r.code === 1 &&
      /R1 @x\/aa/.test(r.out) &&
      /pnpm-lock\.yaml/.test(r.out) &&
      !/Node\.js v/.test(r.out),
  },
  {
    name: "LOCK-CONTROL  an unreadable lockfile alone REFUSES, naming the file",
    tree: { packages: { ok: peerPkg } },
    after: (root) => chmodSync(join(root, "pnpm-lock.yaml"), 0o000),
    expect: (r) =>
      r.code === 2 &&
      /pnpm-lock\.yaml/.test(r.out) &&
      !/FAIL/.test(r.out) &&
      !/Node\.js v/.test(r.out),
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
  // `after` plants what a fixture builder cannot express — e.g. a chmod 000
  // that must land after the file exists (#1215's unreadable-read rows).
  if (c.after) c.after(root);
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
    `      THE LOCKFILE, an unparseable manifest (alone, and beside a computed R1\n` +
    `      failure it may no longer hide), an unreadable source file and an\n` +
    `      unreadable lockfile (each alone, and beside a computed R1 failure), and\n` +
    `      both vacuous sweeps — so its green\n` +
    `      means single instances across the whole declared list rather than merely\n` +
    `      a green.`
);
process.exit(pass === cases.length ? 0 : 1);
