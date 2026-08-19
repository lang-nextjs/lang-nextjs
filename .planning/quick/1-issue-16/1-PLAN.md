---
phase: quick-1-issue-16
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/server/vitest.config.ts
  - packages/server/src/benchmark/transform-throughput.bench.ts
  - packages/server/src/benchmark/sse-parsing.bench.ts
  - packages/server/src/benchmark/container-creation.bench.ts
  - .github/workflows/benchmark.yml
autonomous: true
formal_artifacts: none
requirements: []

must_haves:
  truths:
    - "CI can run benchmark tests and report results"
    - "Benchmark results are stored as CI artifacts"
    - "CI fails when stream transform throughput drops >20% vs baseline on main"
    - "CI fails when SSE parsing speed drops >20% vs baseline on main"
    - "CI fails when container creation time drops >20% vs baseline on main"
  artifacts:
    - path: "packages/server/src/benchmark/transform-throughput.bench.ts"
      provides: "Benchmark for stream transform throughput via SseFrameAccumulator.push()"
      min_lines: 40
    - path: "packages/server/src/benchmark/sse-parsing.bench.ts"
      provides: "Benchmark for SSE parsing speed via stripMessageIdTransform"
      min_lines: 40
    - path: "packages/server/src/benchmark/container-creation.bench.ts"
      provides: "Benchmark for container creation time via createDeepAgentsHandler factory"
      min_lines: 40
    - path: "packages/server/vitest.config.ts"
      provides: "Vitest config updated to include benchmark files"
      contains: "benchmark/**/*.bench.ts"
    - path: ".github/workflows/benchmark.yml"
      provides: "CI workflow for benchmarks with artifact storage and regression detection"
      contains: "regression-threshold 20"
  key_links:
    - from: "packages/server/vitest.config.ts"
      to: "packages/server/src/benchmark/*.bench.ts"
      via: "include pattern benchmark/**/*.bench.ts"
    - from: ".github/workflows/benchmark.yml"
      to: "packages/server"
      via: "pnpm --filter @deepagents-nextjs/server bench"
    - from: ".github/workflows/benchmark.yml"
      to: "artifacts"
      via: "upload-artifact benchmark-results"
---

<objective>
Add Vitest benchmark tests for stream transform throughput, SSE parsing speed, and container creation time, stored as CI artifacts with >20% regression flagging on main branch pushes.
</objective>

<execution_context>
@/Users/jonathanborduas/.claude/nf/workflows/execute-plan.md
</execution_context>

<context>
@packages/server/vitest.config.ts
@packages/server/src/accumulator.ts
@packages/server/src/transforms.ts
@packages/server/src/handler.ts
@.github/workflows/ci.yml
</context>

<tasks>

<task type="auto">
  <name>Update vitest.config.ts to include benchmark files</name>
  <files>packages/server/vitest.config.ts</files>
  <action>
    Update packages/server/vitest.config.ts to include benchmark files by adding 'benchmark/**/*.bench.ts' to the include array alongside existing 'src/**/*.test.ts' pattern. Benchmark tests use the same 'node' environment as unit tests.
  </action>
  <verify>grep "benchmark" packages/server/vitest.config.ts returns match</verify>
  <done>vitest.config.ts includes benchmark/**/*.bench.ts pattern for benchmark discovery</done>
</task>

<task type="auto">
  <name>Create stream transform throughput benchmark</name>
  <files>packages/server/src/benchmark/transform-throughput.bench.ts</files>
  <action>
    Create packages/server/src/benchmark/transform-throughput.bench.ts with benchmark for SseFrameAccumulator.push() performance. Use Vitest bench() API with operations: push with complete frames, push with partial frames (TCP split), push with multiple complete frames, and flush. Run 1000 iterations per operation with reportMedian: true. Use realistic SSE data payloads (1024 bytes) to simulate production traffic patterns.
  </action>
  <verify>pnpm --filter @deepagents-nextjs/server bench runs without error and produces output</verify>
  <done>transform-throughput benchmark measures SseFrameAccumulator.push() performance over 1000 iterations</done>
</task>

<task type="auto">
  <name>Create SSE parsing speed benchmark</name>
  <files>packages/server/src/benchmark/sse-parsing.bench.ts</files>
  <action>
    Create packages/server/src/benchmark/sse-parsing.bench.ts with benchmark for stripMessageIdTransform performance. Use Vitest bench() API with operations: transform finish frame (with messageId to strip), transform regular message frame (passthrough), transform tool-call frame (passthrough), transform mixed frame sequence. Run 1000 iterations per operation with reportMedian: true. Use realistic SSE frame formats matching Django/AI SDK v6 output.
  </action>
  <verify>pnpm --filter @deepagents-nextjs/server bench runs without error and produces output</verify>
  <done>SSE parsing benchmark measures stripMessageIdTransform performance over 1000 iterations</done>
</task>

<task type="auto">
  <name>Create container creation time benchmark</name>
  <files>packages/server/src/benchmark/container-creation.bench.ts</files>
  <action>
    Create packages/server/src/benchmark/container-creation.bench.ts with benchmark for createDeepAgentsHandler factory performance. Use Vitest bench() API with operations: factory creation with default options, factory creation with custom transforms, handler creation with backendUrl. Run 500 iterations per operation with reportMedian: true. Measure synchronous factory call time (not the async stream handling).
  </action>
  <verify>pnpm --filter @deepagents-nextjs/server bench runs without error and produces output</verify>
  <done>container creation benchmark measures createDeepAgentsHandler factory performance over 500 iterations</done>
</task>

<task type="auto">
  <name>Create benchmark CI workflow with regression detection</name>
  <files>.github/workflows/benchmark.yml</files>
  <action>
    Create .github/workflows/benchmark.yml with workflow that:
    1. Triggers on push to main branch and pull requests
    2. Sets up Node.js 22, pnpm, installs dependencies
    3. Runs pnpm bench (Vitest benchmark mode with JSON reporter)
    4. Uploads benchmark-results artifact with JSON output
    5. On main branch push: compares current results to baseline stored in artifact, fails workflow if any benchmark regresses >20% vs baseline
    6. Stores baseline as benchmark-baseline.json in artifacts on main push success

    Use Bencher CLI or custom threshold comparison. Use workflow_dispatch for manual baseline updates. Name job: benchmark-regression.
  </action>
  <verify>ls .github/workflows/benchmark.yml returns file; grep "regression" .github/workflows/benchmark.yml returns match</verify>
  <done>benchmark.yml workflow runs on main push, stores artifacts, and fails on >20% regression</done>
</task>

</tasks>

<verification>
- pnpm --filter @deepagents-nextjs/server bench runs all three benchmarks without errors
- All three benchmark files exist with >40 lines each
- benchmark.yml workflow exists with regression threshold logic
</verification>

<success_criteria>
All three benchmark tests (transform-throughput, sse-parsing, container-creation) run successfully via pnpm bench. CI workflow is configured to detect >20% regressions on main branch pushes and store results as artifacts.
</success_criteria>

<output>
After completion, create .planning/quick/1-issue-16/1-SUMMARY.md
</output>