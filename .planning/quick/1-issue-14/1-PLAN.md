---
phase: 1-issue-14
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/ci.yml
  - .github/dependabot.yml
autonomous: true
requirements:
  - ISSUE-14
formal_artifacts: none

must_haves:
  truths:
    - "pnpm audit runs in CI and fails on high or critical vulnerabilities"
    - "Dependabot opens automated PRs for npm dependency updates on a weekly schedule"
    - "Existing CI jobs (build, test, typecheck, validate) are unaffected"
  artifacts:
    - path: ".github/workflows/ci.yml"
      provides: "Audit step added to CI pipeline"
      contains: "pnpm audit"
    - path: ".github/dependabot.yml"
      provides: "Dependabot configuration for npm ecosystem"
      min_lines: 10
  key_links:
    - from: ".github/workflows/ci.yml"
      to: "pnpm audit"
      via: "step in ci job after install"
      pattern: "pnpm audit"
    - from: ".github/dependabot.yml"
      to: "package-ecosystem: npm"
      via: "Dependabot config"
      pattern: "package-ecosystem"
---

<objective>
Add dependency vulnerability scanning to CI.

Purpose: Prevent known CVEs in transitive dependencies from shipping to production undetected. Issue #14 reports that neither npm audit nor pip audit runs in CI, allowing critical vulnerabilities (prototype pollution, ReDoS) to slip through.
Output: Updated ci.yml with audit step; new dependabot.yml for automated dependency updates.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
@/Users/jonathanborduas/.claude/nf/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.github/workflows/ci.yml
@package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add pnpm audit step to CI workflow</name>
  <files>.github/workflows/ci.yml</files>
  <action>
Read the existing ci.yml. Add a new step AFTER the "Install dependencies" step and BEFORE the "Build" step. The step should be:

```yaml
      - name: Audit dependencies
        run: pnpm audit --audit-level=high
```

The `--audit-level=high` flag causes the command to exit with a non-zero code only when high or critical vulnerabilities are found. Low and moderate vulnerabilities will be reported but will not fail CI.

Do NOT modify any other existing steps. Preserve all existing whitespace and formatting style exactly.
  </action>
  <verify>
    grep -n "pnpm audit" .github/workflows/ci.yml
    grep -A2 "Install dependencies" .github/workflows/ci.yml | grep -q "Audit"
  </verify>
  <done>CI workflow contains a pnpm audit step after install that fails on high/critical vulnerabilities</done>
</task>

<task type="auto">
  <name>Task 2: Add Dependabot configuration</name>
  <files>.github/dependabot.yml</files>
  <action>
Create a new file `.github/dependabot.yml` with the following configuration:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 10
    labels:
      - dependencies
    commit-message:
      prefix: chore
      include: scope

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    labels:
      - dependencies
      - github-actions
    commit-message:
      prefix: ci
      include: scope
```

This configures Dependabot for:
- npm ecosystem (covers all workspace packages via root directory with pnpm)
- GitHub Actions ecosystem (keeps action versions like checkout@v4, setup-node@v4 current)
- Weekly schedule on Mondays
- Reasonable PR limits (10 for npm, 5 for actions)
- Scoped commit messages matching repo convention (chore(deps): / ci(deps):)
  </action>
  <verify>
    test -f .github/dependabot.yml
    grep -q "package-ecosystem: npm" .github/dependabot.yml
    grep -q "package-ecosystem: github-actions" .github/dependabot.yml
    grep -q "interval: weekly" .github/dependabot.yml
  </verify>
  <done>Dependabot configured for weekly npm and GitHub Actions dependency updates</done>
</task>

</tasks>

<verification>
1. `grep -c "pnpm audit" .github/workflows/ci.yml` returns 1 (exactly one audit step)
2. `test -f .github/dependabot.yml` passes
3. `cat .github/workflows/ci.yml` shows audit step positioned after install, before build
4. `cat .github/dependabot.yml` shows both npm and github-actions ecosystems configured
5. YAML syntax is valid for both files (no indentation errors)
</verification>

<success_criteria>
- CI workflow has `pnpm audit --audit-level=high` step that fails on high/critical CVEs
- Dependabot is configured for npm and github-actions ecosystems with weekly schedule
- No existing CI steps are removed or reordered
</success_criteria>

<output>
After completion, create `.planning/quick/1-issue-14/1-SUMMARY.md`
</output>
