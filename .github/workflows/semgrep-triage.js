#!/usr/bin/env node
'use strict';
/**
 * Semgrep triage gate.
 *
 * Reads real `semgrep scan --json` output and fails on any finding that is not
 * covered by a NAMED (rule × path) exception below.
 *
 * Why a triage script instead of `--exclude=rungs`:
 * we REDISTRIBUTE the vendored tree. A real vulnerability in vendored upstream
 * becomes our problem the moment a forker ships it. A path exclusion is a check
 * that cannot fail over a subject that keeps growing — the same defect that
 * turned an earlier apps/open-swe exclusion into a silent ratchet.
 *
 * An exception here is bound to BOTH the rule id AND the exact file path. A new
 * rule firing in the same file blocks. The same rule firing in a different file
 * blocks. Upstream moving the file blocks — deliberately: a moved file deserves
 * re-review, and that rot fails CLOSED.
 *
 * Every entry records what was actually assessed, not "it's vendored".
 */

const EXCEPTIONS = [
  {
    rule: 'javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length',
    path: 'rungs/5-software-developer-agent/packages/shared/src/crypto.ts',
    verdict: 'TRUE POSITIVE on the pattern, NOT EXPLOITABLE as written.',
    reason:
      'createDecipheriv() is called without an explicit { authTagLength }. The ' +
      'rule\'s concern is an attacker supplying a SHORT auth tag, which weakens ' +
      'GCM forgery resistance. That cannot happen here: decryptSecret() slices ' +
      'the tag itself as exactly the last TAG_LENGTH (16) bytes, and rejects any ' +
      'input shorter than IV_LENGTH + TAG_LENGTH + 1. The tag length is fixed by ' +
      'the caller, never by the attacker. Upstream code we do not own; the fix ' +
      'would be a one-line { authTagLength: 16 } and is worth sending upstream.',
  },
  {
    rule: 'javascript.lang.security.detect-child-process.detect-child-process',
    path: 'rungs/5-software-developer-agent/apps/open-swe/src/utils/shell-executor/local-shell-executor.ts',
    verdict: 'INTENDED BEHAVIOUR, and genuinely dangerous — see the warning below.',
    reason:
      'spawn(shellPath, ["-c", command]) executes arbitrary commands. This is a ' +
      'shell executor for an autonomous coding agent: running arbitrary commands ' +
      'IS the feature, so it is not an unintended flaw and cannot be "fixed". ' +
      'BUT the honest description is that it runs on the HOST, inherits the full ' +
      'parent process.env (every secret the operator exported), and applies NO ' +
      'sandboxing. An agent driven by untrusted input — a GitHub issue body, a ' +
      'webhook payload — is therefore host RCE with the operator\'s credentials. ' +
      'Suppressed as a SCANNER finding, NOT dismissed as a risk: rung 5\'s guide ' +
      'must carry this warning.',
  },
  {
    rule: 'package_managers.yarn.yarn-missing-minimal-age-gate.yarn-missing-minimal-age-gate',
    path: 'rungs/5-software-developer-agent/.yarnrc.yml',
    verdict: 'TRUE POSITIVE, low severity, upstream hardening gap.',
    reason:
      'Upstream .yarnrc.yml sets no npmMinimalAgeGate, so a `yarn install` in the ' +
      'vendored tree can resolve a package published minutes ago. A real supply- ' +
      'chain hardening gap, not a vulnerability. This repo builds with pnpm and ' +
      'never runs yarn there; it reaches a forker only if they eject to rung 5 ' +
      'and run yarn. Worth an upstream PR adding npmMinimalAgeGate: "7d".',
  },
];

function triage(findings, exceptions = EXCEPTIONS) {
  const blocking = [], suppressed = [];
  for (const f of findings) {
    const hit = exceptions.find((e) => e.rule === f.check_id && e.path === f.path);
    (hit ? suppressed : blocking).push({ rule: f.check_id, path: f.path, line: f.line, ex: hit });
  }
  return { ok: blocking.length === 0, blocking, suppressed };
}

module.exports = { triage, EXCEPTIONS };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: semgrep-triage.js <semgrep-json>'); process.exit(2); }
  const raw = require(require('path').resolve(file));
  const findings = (raw.results || []).map((r) => ({
    check_id: r.check_id, path: r.path, line: r.start && r.start.line,
  }));
  console.log(`semgrep findings: ${findings.length}`);
  const { ok, blocking, suppressed } = triage(findings);

  for (const s of suppressed) {
    console.log(`\nsuppressed: ${s.rule}\n  at ${s.path}:${s.line}\n  ${s.ex.verdict}\n  ${s.ex.reason}`);
  }
  if (!ok) {
    console.log('');
    console.log('::error::Semgrep finding(s) with no named exception:');
    for (const b of blocking) console.log(`  ${b.rule}\n    at ${b.path}:${b.line}`);
    console.log('');
    console.log('Assess it. If it is real, fix it or report upstream. If it is not,');
    console.log('add a NAMED (rule + exact path) exception to');
    console.log('.github/workflows/semgrep-triage.js with your reasoning.');
    console.log('Do NOT add a path exclusion for the vendored tree — we redistribute it.');
    process.exit(1);
  }
  console.log('\nAll semgrep findings are covered by named exceptions.');
}
