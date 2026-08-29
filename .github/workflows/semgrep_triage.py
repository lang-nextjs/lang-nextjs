#!/usr/bin/env python3
"""Semgrep triage gate.

Reads real `semgrep scan --json` output and fails on any finding not covered by
a NAMED (rule x path) exception below.

WHY PYTHON, NOT NODE: this runs inside the pinned `semgrep/semgrep` container,
which ships Python and semgrep and NO Node. The first version of this gate was
Node and died at `node: not found` (exit 127) before it could judge anything.
Keeping the judge in the scan's own container means the report never crosses a
boundary where it could be absent for an unrelated reason.

WHY ONE FILE INSTEAD OF gate + separate selftest: the Node version had the
selftest as its own CI step, and that step is exactly what vanished. The
selftest cases now live here and RUN IN-PROCESS before any judging. The gate
cannot execute without its own harness executing first. A separate step can be
deleted; this cannot.

WHY A TRIAGE SCRIPT INSTEAD OF `--exclude=rungs`: we REDISTRIBUTE the vendored
tree. A real vulnerability there becomes our problem the moment a forker ships
it. A path exclusion is a check that cannot fail over a subject that keeps
growing. Exceptions here bind to BOTH rule id AND exact path: a new rule in an
excepted file blocks, the same rule at a new path blocks, and upstream moving a
file blocks -- deliberately, because a moved file deserves re-review and that
rot fails CLOSED.
"""

import json
import os
import sys

EXCEPTIONS = [
    {
        "rule": "javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length",
        "path": "rungs/5-software-developer-agent/packages/shared/src/crypto.ts",
        "verdict": "TRUE POSITIVE on the pattern, NOT EXPLOITABLE as written.",
        "reason": (
            "createDecipheriv() is called without an explicit authTagLength. The rule's "
            "concern is an attacker supplying a SHORT auth tag, which weakens GCM forgery "
            "resistance. That cannot happen here: decryptSecret() slices the tag itself as "
            "exactly the last TAG_LENGTH (16) bytes and rejects input shorter than "
            "IV_LENGTH + TAG_LENGTH + 1, so tag length is fixed by the caller, never the "
            "attacker. Upstream code we do not own; a one-line {authTagLength: 16} is worth "
            "sending upstream. SEE #82: the SAME FILE has a real weakness four lines away "
            "that no scanner flagged -- deriveKey() is a single-pass SHA-256 over an "
            "operator-supplied env var. A gate that runs is not a gate that covers."
        ),
    },
    {
        "rule": "javascript.lang.security.detect-child-process.detect-child-process",
        "path": "rungs/5-software-developer-agent/apps/open-swe/src/utils/shell-executor/local-shell-executor.ts",
        "verdict": "INTENDED BEHAVIOUR, and genuinely dangerous -- see the warning.",
        "reason": (
            "spawn(shellPath, ['-c', command]) executes arbitrary commands. This is a shell "
            "executor for an autonomous coding agent: running arbitrary commands IS the "
            "feature, so it is not an unintended flaw and cannot be fixed. BUT the honest "
            "description is that it runs on the HOST, inherits the full parent process.env "
            "(every secret the operator exported), and applies NO sandboxing. An agent "
            "driven by untrusted input -- a GitHub issue body, a webhook payload -- is "
            "therefore host RCE with the operator's credentials. Suppressed as a SCANNER "
            "finding, NOT dismissed as a risk: rung 5's guide must carry this warning."
        ),
    },
    {
        "rule": "javascript.express.security.cors-misconfiguration.cors-misconfiguration",
        "path": "apps/node-backend/src/server.ts",
        "verdict": (
            "FALSE POSITIVE on exploitability -- the echo is guarded by a closed "
            "allowlist identical to the two Python backends'. The assessment found a "
            "REAL defect beside it, which is FIXED, not excepted."
        ),
        "reason": (
            "THE FINDING. The rule fires on res.setHeader('Access-Control-Allow-Origin', "
            "origin) reflecting a request-controlled value. It cannot see the line above: "
            "ALLOWED_ORIGINS.has(origin) is checked first, over a module-level Set of five "
            "literal origins. The header takes ONE origin or '*' and never a list, so "
            "echoing-from-an-allowlist is the only correct way to serve several origins. "
            "Neither '*' nor an unguarded reflection appears. "
            "REACHABILITY -- THE DEPLOYED CASE, NOT THE DEV BOX. This backend is reached by "
            "the same Next.js proxy that reaches django and fastapi, so its policy is "
            "reachable from wherever that proxy runs, and 'it is scaffold' is exactly the "
            "reasoning that survives to production. Three things bound it. FIRST, the "
            "production path does not use CORS AT ALL: the proxy calls the backend from "
            "packages/server/src/handler.ts with a server-side fetch(), which sends no "
            "Origin header and triggers no preflight. CORS here governs only DIRECT "
            "browser access, which is a development affordance. SECOND, the policy is "
            "bounded whether or not it is deployed -- five literal origins, and the risk "
            "CORS actually addresses (a page on evil.com using a victim's browser to READ "
            "a response from a host only that browser can reach) is blocked for every "
            "origin outside the set. THIRD, Access-Control-Allow-Credentials is never set, "
            "so no allowed origin can read an identity-dependent response either. "
            "IDENTICAL TO THE PYTHON PLANES, verified line by line: fastapi's "
            "CORSMiddleware(allow_origins=[...]) in main.py and django's "
            "CORS_ALLOWED_ORIGINS in settings.py carry the SAME five origins, the same "
            "allow_methods ['POST','OPTIONS'] and the same allow_headers "
            "['Content-Type','Authorization']. Diverging in the scaffold would give three "
            "interchangeable runtimes three CORS policies, which is worse than the "
            "residual below. "
            "THE RESIDUAL, STATED RATHER THAN BURIED. The list contains "
            "http://localhost:3000-3002. Deployed, that means a page served from a "
            "VICTIM'S OWN MACHINE on those ports can read this backend. It is narrow and "
            "it is dev configuration shipped to production -- and it is a property of all "
            "THREE runtimes, not something this file introduced, so it is filed as "
            "#349 rather than fixed asymmetrically here. "
            "WHAT THE AUDIT FOUND ON ITS OWN: `Vary: Origin` was MISSING. A genuine "
            "cache-poisoning gap for any origin-reflecting CORS -- a shared cache keying "
            "only on the URL can hand one origin's headers to another -- and FastAPI's "
            "middleware sets it automatically, so 'mirrors the Python' was not yet true "
            "when the rule fired. FIXED in the same commit, unconditionally rather than "
            "inside the allowed branch, because the ABSENCE of CORS headers is "
            "origin-dependent too. "
            "FIRST EXCEPTION FOR A FILE THIS REPO AUTHORS -- every other entry here is "
            "vendored rung-5 code. So the premise is TESTED, not asserted: "
            "apps/node-backend/src/server.test.ts fails if an unlisted origin is ever "
            "echoed, if Vary goes missing, or if credentials are granted. Widening the "
            "guard turns THIS reasoning false and goes red, instead of the exception "
            "silently covering something it was never written for."
        ),
    },
    {
        "rule": "package_managers.yarn.yarn-missing-minimal-age-gate.yarn-missing-minimal-age-gate",
        "path": "rungs/5-software-developer-agent/.yarnrc.yml",
        "verdict": "TRUE POSITIVE, low severity, upstream hardening gap.",
        "reason": (
            "Upstream .yarnrc.yml sets no npmMinimalAgeGate, so a `yarn install` in the "
            "vendored tree can resolve a package published minutes ago. A real supply-chain "
            "hardening gap, not a vulnerability. This repo builds with pnpm and never runs "
            "yarn there; it reaches a forker only if they eject to rung 5 and run yarn. "
            "Worth an upstream PR adding npmMinimalAgeGate: '7d'."
        ),
    },
]


def triage(findings, exceptions=None):
    """Return (ok, blocking, suppressed). A finding passes only on an exact
    (rule, path) match against an exception."""
    if exceptions is None:
        exceptions = EXCEPTIONS
    blocking, suppressed = [], []
    for f in findings:
        hit = None
        for e in exceptions:
            if e["rule"] == f["rule"] and e["path"] == f["path"]:
                hit = e
                break
        (suppressed if hit else blocking).append(dict(f, ex=hit))
    return (len(blocking) == 0), blocking, suppressed


def load_findings(path):
    with open(path) as fh:
        raw = json.load(fh)
    out = []
    for r in raw.get("results", []):
        start = r.get("start") or {}
        out.append({"rule": r.get("check_id"), "path": r.get("path"), "line": start.get("line")})
    return out


# --------------------------------------------------------------------------
# Selftest -- runs IN-PROCESS before any judging. See module docstring.
# --------------------------------------------------------------------------
R_GCM = "javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length"
R_CP = "javascript.lang.security.detect-child-process.detect-child-process"
R_YARN = "package_managers.yarn.yarn-missing-minimal-age-gate.yarn-missing-minimal-age-gate"
P_CRYPTO = "rungs/5-software-developer-agent/packages/shared/src/crypto.ts"
P_SHELL = "rungs/5-software-developer-agent/apps/open-swe/src/utils/shell-executor/local-shell-executor.ts"
P_YARN = "rungs/5-software-developer-agent/.yarnrc.yml"


def _cases():
    F = lambda r, p, l=1: {"rule": r, "path": p, "line": l}

    yield ("ACCEPT: the three known vendored findings pass",
           lambda: triage([F(R_GCM, P_CRYPTO, 115), F(R_CP, P_SHELL, 81), F(R_YARN, P_YARN)])[0] is True)

    # PATH-BOUND -- an excepted rule firing elsewhere must still block.
    yield ("REJECT: excepted rule at a DIFFERENT path still blocks",
           lambda: triage([F(R_CP, "rungs/5-software-developer-agent/apps/open-swe/src/other.ts", 3)])[0] is False)

    # RULE-BOUND -- a different rule in an excepted file must still block.
    yield ("REJECT: a DIFFERENT rule in an excepted file still blocks",
           lambda: triage([F(R_CP, P_CRYPTO, 136)])[0] is False)

    yield ("REJECT: any other rule anywhere in the vendored tree blocks",
           lambda: triage([F("javascript.lang.security.audit.sqli", "rungs/5-software-developer-agent/x.ts")])[0] is False)

    yield ("REJECT: with exceptions removed, the known findings block again",
           lambda: triage([F(R_GCM, P_CRYPTO, 115), F(R_CP, P_SHELL, 81)], [])[0] is False)

    yield ("ACCEPT: a clean scan passes",
           lambda: triage([])[0] is True)

    yield ("every exception carries a verdict and a real assessment",
           lambda: all(len(e.get("verdict", "")) > 20 and len(e.get("reason", "")) > 80 for e in EXCEPTIONS))


def run_selftest(verbose=True):
    failed = 0
    if verbose:
        print("semgrep-triage selftest:")
    for name, fn in _cases():
        try:
            ok = fn()
        except Exception as exc:  # a throwing case is a failing case
            ok, name = False, name + " (raised %s)" % exc
        if not ok:
            failed += 1
        if verbose:
            print("  %s  %s" % ("PASS" if ok else "FAIL", name))
    return failed


def main(argv):
    selftest_only = "--selftest" in argv
    args = [a for a in argv if not a.startswith("--")]

    failed = run_selftest(verbose=True)
    if failed:
        print("")
        print("::error::semgrep triage SELFTEST FAILED (%d case(s)) -- the gate cannot be trusted, "
              "so nothing is being judged." % failed)
        return 1
    print("selftest: all cases passed -- the gate is rule-bound AND path-bound.\n")

    if selftest_only:
        return 0

    if not args:
        print("usage: semgrep_triage.py <semgrep-json> [--selftest]", file=sys.stderr)
        return 2
    report = args[0]
    if not os.path.exists(report) or os.path.getsize(report) == 0:
        print("::error::semgrep report %r is missing or empty -- refusing to pass." % report)
        return 1

    findings = load_findings(report)
    print("semgrep findings: %d" % len(findings))
    ok, blocking, suppressed = triage(findings)

    for s in suppressed:
        print("\nsuppressed: %s\n  at %s:%s\n  %s\n  %s"
              % (s["rule"], s["path"], s["line"], s["ex"]["verdict"], s["ex"]["reason"]))

    if not ok:
        print("")
        print("::error::Semgrep finding(s) with no named exception:")
        for b in blocking:
            print("  %s\n    at %s:%s" % (b["rule"], b["path"], b["line"]))
        print("")
        print("Assess it. If it is real, fix it or report upstream. If it is not, add a")
        print("NAMED (rule + exact path) exception to .github/workflows/semgrep_triage.py")
        print("with your reasoning. Do NOT add a path exclusion for the vendored tree --")
        print("we redistribute it.")
        return 1

    print("\nAll semgrep findings are covered by named exceptions.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
