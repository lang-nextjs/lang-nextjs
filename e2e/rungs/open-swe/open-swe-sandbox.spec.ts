import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

/**
 * Real E2E for the open-swe Docker sandbox (/api/open-swe/sandbox/*).
 *
 * No mocks — these exercise the full path: API route → getSandbox() →
 * DockerSandbox → the real `docker` CLI → a real container. They skip
 * gracefully when no Docker daemon is reachable.
 *
 * Runs in the chromium-sandbox project against open-swe on :3001.
 *   CI:    the e2e-sandbox job (.github/workflows/e2e.yml)
 *   Local: pnpm --filter open-swe dev   then   pnpm e2e --project=chromium-sandbox
 */

/**
 * Ask the local `docker` CLI which containers match, and REFUSE to guess.
 *
 * WHY THIS EXISTS (#736). Both cleanup assertions used to read:
 *
 *     const ps = execSync(
 *       `docker ps -aq --filter "name=${names}" 2>/dev/null || true`,
 *       { encoding: "utf-8" }
 *     ).trim();
 *     expect(ps, "...leaked...").toBe("");
 *
 * Three things conspired there. `|| true` replaces the exit status with 0,
 * `2>/dev/null` discards the reason, and the assertion then reads "" as PROOF
 * OF CLEANUP. So "no container leaked" and "I could not ask docker" produce the
 * identical verdict, and the second one passes. `docker` absent from PATH exits
 * 127; `|| true` makes that 0 and stdout is empty; both assertions go green
 * having checked nothing.
 *
 * THE PRECONDITION DOES NOT COVER IT. `requireDockerOrSkip` probes
 * `/api/open-swe/sandbox/health` — the APP's endpoint, over HTTP. These calls
 * shell out to the LOCAL docker CLI. Different channels: the app can answer
 * `available: true` from a machine where this process cannot run `docker` at
 * all. And note where the two affected assertions sit — they are the ones
 * verifying cleanup AT THE DAEMON, which the guard above deliberately throws
 * rather than skips for in CI. The two strongest guarantees in this file were
 * the two that could pass without a daemon answering.
 *
 * `|| true` was not careless: `execSync` throws on a non-zero exit, and "no
 * containers matched" is a perfectly good answer that must not become an
 * exception. The repair is to SEPARATE the two answers rather than delete the
 * guard — argv form, no shell, read the status, and let an empty string mean
 * only "docker answered, and the answer was none".
 *
 * `bin` is a parameter so the failure paths can be witnessed without
 * uninstalling docker; see the DOCKER-CLI tests at the foot of this file.
 */
function runDocker(args: string[], bin = "docker"): string {
  const res = spawnSync(bin, args, { encoding: "utf-8" });

  // The binary never ran — not on PATH, not executable, spawn refused.
  if (res.error) {
    throw new Error(
      `docker could not be run (${bin}): ${res.error.message}. ` +
        "An empty result from a docker that never answered is not evidence " +
        "of anything, so this fails rather than reporting none."
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `\`${bin} ${args.join(" ")}\` exited ${res.status}` +
        `${res.signal ? ` (signal ${res.signal})` : ""}: ` +
        `${(res.stderr || "").trim() || "<no stderr>"}`
    );
  }
  return (res.stdout || "").trim();
}

/** Container ids matching `filters`. "" means docker answered: none. */
function dockerPs(filters: string[], bin = "docker"): string {
  return runDocker(["ps", "-aq", ...filters], bin);
}

/**
 * Remove a container, failing loudly if it did not happen.
 *
 * This is a test's SETUP step, not an assertion, which is exactly why it has to
 * be checked: the test that calls it kills a container behind the app's back
 * and then asserts that exec against the dead workspace fails. If the removal
 * silently did not happen, the assertion runs against a LIVE container and can
 * pass for the wrong reason. The argv form also stops an API-supplied container
 * name from reaching a shell.
 */
function dockerRm(containerName: string, bin = "docker"): void {
  runDocker(["rm", "-f", containerName], bin);
}

async function dockerAvailable(
  request: import("@playwright/test").APIRequestContext
): Promise<boolean> {
  const res = await request.get("/api/open-swe/sandbox/health");
  const body = await res.json();
  return body.available === true;
}

/**
 * Skip when Docker is unavailable AND we're in local dev. In CI (process.env.CI
 * set), throw instead — this job exists to exercise Docker and a silent skip
 * would be a false-green. The workflow has a precheck step that ALSO fails
 * fast, but this in-spec guard is belt-and-braces in case someone runs
 * `CI=true pnpm e2e --project=chromium-sandbox` directly.
 */
async function requireDockerOrSkip(
  request: import("@playwright/test").APIRequestContext
): Promise<void> {
  const ok = await dockerAvailable(request);
  if (ok) return;
  if (process.env.CI === "true") {
    throw new Error(
      "Docker daemon not available — chromium-sandbox tests must NOT silently skip in CI"
    );
  }
  test.skip(true, "Docker daemon not available — skipping real sandbox E2E");
}

test.describe("OpenSWE sandbox — real Docker", () => {
  test("SANDBOX-00: health endpoint contract — {provider, available, detail} with status 200/503", async ({
    request,
  }) => {
    // The requireDockerOrSkip helper above reads body.available to decide
    // whether to skip. If the endpoint's shape ever drifts (renames
    // `available` to `up`, hoists fields, returns string-bool, etc.),
    // every sandbox test would either silently skip in CI (false-green)
    // or throw unhelpfully. This test pins the contract.
    //
    // In the e2e-sandbox CI job Docker is always available (the workflow's
    // precheck enforces it), so we only get to assert the available=true
    // branch here. The available=false branch's status=503 mapping is
    // documented in route.ts; this test can't exercise it without
    // mocking the sandbox provider.
    const res = await request.get("/api/open-swe/sandbox/health");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(
      typeof body.available,
      "body.available must be a boolean — requireDockerOrSkip depends on it"
    ).toBe("boolean");
    expect(body.available, "in CI Docker must be up").toBe(true);
    expect(
      typeof body.provider,
      "body.provider must be a string (e.g. 'docker')"
    ).toBe("string");
    expect(
      body.detail,
      "body.detail must be defined (used by error UI when available=false)"
    ).toBeDefined();
  });

  test("SANDBOX-01: health probe and a full create → get → destroy lifecycle", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);
    const health = await request.get("/api/open-swe/sandbox/health");
    const healthBody = await health.json();
    expect(health.status()).toBe(200);
    expect(healthBody.provider).toBe("docker");
    expect(healthBody.available).toBe(true);

    const created = await request.post("/api/open-swe/sandbox/workspaces", {
      data: { label: "e2e-sandbox-01" },
    });
    expect(created.status()).toBe(201);
    const ws = await created.json();
    expect(ws.id).toBeTruthy();
    expect(ws.status).toBe("ready");

    try {
      const got = await request.get(
        `/api/open-swe/sandbox/workspaces/${ws.id}`
      );
      expect(got.status()).toBe(200);
      expect((await got.json()).id).toBe(ws.id);
    } finally {
      const destroyed = await request.delete(
        `/api/open-swe/sandbox/workspaces/${ws.id}`
      );
      expect(destroyed.status()).toBe(204);
    }

    // The workspace is gone after teardown.
    const after = await request.get(
      `/api/open-swe/sandbox/workspaces/${ws.id}`
    );
    expect(after.status()).toBe(404);
  });

  test("SANDBOX-02: a tool runs inside the workspace and returns real output", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);

    const ws = await (
      await request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: "e2e-sandbox-02" },
      })
    ).json();

    try {
      // A command that succeeds.
      const ok = await request.post(
        `/api/open-swe/sandbox/workspaces/${ws.id}/exec`,
        { data: { command: "sh", args: ["-c", "echo sandbox-ok"] } }
      );
      expect(ok.status()).toBe(200);
      const okBody = await ok.json();
      expect(okBody.exitCode).toBe(0);
      expect(okBody.stdout).toContain("sandbox-ok");
      expect(okBody.timedOut).toBe(false);

      // A command that fails — a non-zero exit is still HTTP 200.
      const failed = await request.post(
        `/api/open-swe/sandbox/workspaces/${ws.id}/exec`,
        { data: { command: "sh", args: ["-c", "exit 3"] } }
      );
      expect(failed.status()).toBe(200);
      expect((await failed.json()).exitCode).toBe(3);
    } finally {
      await request.delete(`/api/open-swe/sandbox/workspaces/${ws.id}`);
    }
  });

  test("SANDBOX-03: concurrent workspaces are isolated; capacity is accounted", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);

    const before = await (
      await request.get("/api/open-swe/sandbox/capacity")
    ).json();

    const [resA, resB] = await Promise.all([
      request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: "e2e-a" },
      }),
      request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: "e2e-b" },
      }),
    ]);
    const wsA = await resA.json();
    const wsB = await resB.json();
    expect(wsA.id).not.toBe(wsB.id);
    expect(wsA.containerName).not.toBe(wsB.containerName);

    try {
      // Write a distinct marker into each workspace's filesystem.
      await request.post(`/api/open-swe/sandbox/workspaces/${wsA.id}/exec`, {
        data: { command: "sh", args: ["-c", "echo AAA > /tmp/marker"] },
      });
      await request.post(`/api/open-swe/sandbox/workspaces/${wsB.id}/exec`, {
        data: { command: "sh", args: ["-c", "echo BBB > /tmp/marker"] },
      });

      // Each workspace sees only its own marker — no cross-contamination.
      const readA = await (
        await request.post(`/api/open-swe/sandbox/workspaces/${wsA.id}/exec`, {
          data: { command: "cat", args: ["/tmp/marker"] },
        })
      ).json();
      const readB = await (
        await request.post(`/api/open-swe/sandbox/workspaces/${wsB.id}/exec`, {
          data: { command: "cat", args: ["/tmp/marker"] },
        })
      ).json();
      expect(readA.stdout).toContain("AAA");
      expect(readA.stdout).not.toContain("BBB");
      expect(readB.stdout).toContain("BBB");
      expect(readB.stdout).not.toContain("AAA");

      const during = await (
        await request.get("/api/open-swe/sandbox/capacity")
      ).json();
      expect(during.used).toBeGreaterThanOrEqual(before.used + 2);
    } finally {
      await Promise.all([
        request.delete(`/api/open-swe/sandbox/workspaces/${wsA.id}`),
        request.delete(`/api/open-swe/sandbox/workspaces/${wsB.id}`),
      ]);
    }
  });

  test("SANDBOX-04: execTimeoutMs kills a long-running command and surfaces timedOut=true", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);

    // Create a workspace with a 1-second exec timeout (default is 30s).
    const ws = await (
      await request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: "e2e-timeout", execTimeoutMs: 1000 },
      })
    ).json();

    try {
      const started = Date.now();
      const res = await request.post(
        `/api/open-swe/sandbox/workspaces/${ws.id}/exec`,
        { data: { command: "sleep", args: ["10"] } }
      );
      const elapsed = Date.now() - started;
      expect(res.status()).toBe(200);
      const body = await res.json();
      // The killed process surfaces timedOut=true and a non-zero exit.
      expect(body.timedOut).toBe(true);
      expect(body.exitCode).not.toBe(0);
      // The elapsed time must be CLOSE to 1s (the configured execTimeoutMs),
      // not the 30s default. Lower bound 200ms is a sanity check — anything
      // below that means the call never actually waited for the timeout. Upper
      // bound 2500ms catches a silent fallback where execTimeoutMs is ignored
      // and the default (or any value > 2.5s) is used instead.
      expect(elapsed).toBeGreaterThan(200);
      expect(elapsed).toBeLessThan(2_500);

      // The workspace must remain usable after a timed-out command. A fresh
      // (fast) command should succeed normally — proving the container wasn't
      // torn down or wedged by the kill.
      const afterRes = await request.post(
        `/api/open-swe/sandbox/workspaces/${ws.id}/exec`,
        { data: { command: "echo", args: ["alive"] } }
      );
      const afterBody = await afterRes.json();
      expect(afterBody.exitCode).toBe(0);
      expect(afterBody.timedOut).toBe(false);
      expect(afterBody.stdout).toContain("alive");
    } finally {
      await request.delete(`/api/open-swe/sandbox/workspaces/${ws.id}`);
    }
  });

  test("SANDBOX-05: at-capacity creates return 429 with code='at_capacity'", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);

    const capBefore = await (
      await request.get("/api/open-swe/sandbox/capacity")
    ).json();
    // Fill exactly the available slots, then attempt one more — that one
    // must be the 429. This is bounded by capBefore.available; default
    // SANDBOX_MAX_WORKSPACES is 8, so worst case is 8 creates + 1 reject.
    // For faster local runs, start the server with SANDBOX_MAX_WORKSPACES=2.
    if (capBefore.available > 8) {
      // A wildly large cap would explode the test runtime — skip with note.
      test.skip(
        true,
        `SANDBOX_MAX_WORKSPACES is ${capBefore.max}; set it to <= 8 to run this test`
      );
    }
    test.setTimeout(120_000); // generous: each create is a real `docker run`

    // Unique label prefix per test run so we can verify cleanup at the end
    // without colliding with any other parallel test's containers.
    const labelPrefix = `e2e-cap-${Date.now()}`;
    const created: { id: string; containerName: string }[] = [];
    try {
      // Fill every remaining slot.
      for (let i = 0; i < capBefore.available; i++) {
        const res = await request.post("/api/open-swe/sandbox/workspaces", {
          data: { label: `${labelPrefix}-${i}` },
        });
        expect(
          res.status(),
          `slot ${i}/${capBefore.available} must accept`
        ).toBe(201);
        created.push(await res.json());
      }

      // The next create MUST be rejected with 429 / at_capacity.
      const overflow = await request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: `${labelPrefix}-overflow` },
      });
      expect(overflow.status()).toBe(429);
      const overflowBody = await overflow.json();
      expect(overflowBody.code).toBe("at_capacity");
      expect(overflowBody.error).toMatch(/capacity/i);

      // Capacity endpoint should reflect the full state too.
      const capDuring = await (
        await request.get("/api/open-swe/sandbox/capacity")
      ).json();
      expect(capDuring.available).toBe(0);
      expect(capDuring.used).toBe(capDuring.max);
    } finally {
      // Destroy every workspace we created. Settle individually so a single
      // 4xx/5xx doesn't mask whether the others cleaned up.
      const deleteResults = await Promise.all(
        created.map((w) =>
          request
            .delete(`/api/open-swe/sandbox/workspaces/${w.id}`)
            .then((r) => ({ id: w.id, status: r.status() }))
            .catch((e) => ({ id: w.id, status: -1, error: String(e) }))
        )
      );
      // Any non-204 delete is a sandbox API regression — surface it loudly.
      const failed = deleteResults.filter((r) => r.status !== 204);
      expect(
        failed,
        `every workspace must DELETE cleanly; failures: ${JSON.stringify(
          failed
        )}`
      ).toEqual([]);

      // Verifiable cleanup: list containers that this test created by name.
      // If the sandbox API said it deleted them, `docker ps -a` must agree.
      const containerNames = created.map((w) => w.containerName).join("|");
      // argv form: the names go to docker as one argument, so they are neither
      // re-split nor interpreted by a shell that is no longer in the path.
      const ps = dockerPs([
        "--filter",
        "label=open-swe.sandbox=1",
        "--filter",
        `name=${containerNames}`,
      ]);
      expect(
        ps,
        `no container from this run may remain after cleanup; leaked: ${ps}`
      ).toBe("");
    }
  });

  test("SANDBOX-06: exec passes args as argv — shell metacharacters are not interpreted", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);

    const ws = await (
      await request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: "e2e-injection" },
      })
    ).json();

    try {
      // Seed a sentinel file that an injection attempt could try to delete.
      await request.post(`/api/open-swe/sandbox/workspaces/${ws.id}/exec`, {
        data: {
          command: "sh",
          args: ["-c", "echo SENTINEL > /tmp/sentinel"],
        },
      });

      // Attempt classic injection patterns as separate argv entries to `echo`.
      // Because the sandbox calls docker exec with argv (no intermediate shell),
      // the `;`, `&&`, `|`, `$(...)`, backticks must be passed LITERALLY to
      // echo's stdout — not interpreted to run additional commands.
      const injection = await (
        await request.post(`/api/open-swe/sandbox/workspaces/${ws.id}/exec`, {
          data: {
            command: "echo",
            args: [
              "hello",
              ";",
              "rm",
              "-rf",
              "/tmp/sentinel",
              "&&",
              "$(rm /tmp/sentinel)",
              "|",
              "`rm /tmp/sentinel`",
            ],
          },
        })
      ).json();
      expect(injection.exitCode).toBe(0);
      // Each arg appears verbatim in stdout (echo joins argv with spaces).
      expect(injection.stdout).toContain("; rm -rf /tmp/sentinel");
      expect(injection.stdout).toContain("$(rm /tmp/sentinel)");
      expect(injection.stdout).toContain("`rm /tmp/sentinel`");

      // The sentinel file must still exist — none of the injection attempts
      // actually ran rm.
      const probe = await (
        await request.post(`/api/open-swe/sandbox/workspaces/${ws.id}/exec`, {
          data: { command: "cat", args: ["/tmp/sentinel"] },
        })
      ).json();
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout).toContain("SENTINEL");
    } finally {
      await request.delete(`/api/open-swe/sandbox/workspaces/${ws.id}`);
    }
  });

  test("SANDBOX-07: external container kill is detected by exec and capacity recovers after destroy", async ({
    request,
  }) => {
    await requireDockerOrSkip(request);

    const ws = await (
      await request.post("/api/open-swe/sandbox/workspaces", {
        data: { label: "e2e-crash" },
      })
    ).json();
    const containerName: string = ws.containerName;
    expect(containerName).toMatch(/^open-swe-ws-/);

    const capBefore = await (
      await request.get("/api/open-swe/sandbox/capacity")
    ).json();

    try {
      // Externally kill the container behind the workspace, bypassing the
      // sandbox API. The sandbox singleton still has the workspace in its
      // in-memory map, but the underlying container is gone.
      dockerRm(containerName);

      // exec against the dead workspace must fail with an error code — NOT
      // hang, NOT return success. Two acceptable failure shapes:
      //   A) 5xx HTTP — docker exec errored at the daemon, surfaced as a
      //      sandbox error (exec_failed → 502).
      //   B) 200 HTTP with non-zero exit code AND stderr referencing the
      //      missing container (some docker versions return a 200 with the
      //      exec error in stderr/exit).
      // Anything else (200 + exit 0 + clean stdout) is a real bug.
      const dead = await request.post(
        `/api/open-swe/sandbox/workspaces/${ws.id}/exec`,
        { data: { command: "echo", args: ["should-not-run"] } }
      );
      const status = dead.status();

      if (status >= 500) {
        // Shape A: 5xx with an error code body.
        const body = await dead.json();
        expect(
          body.code,
          "5xx response must include a sandbox error code"
        ).toMatch(/exec_failed|docker_unavailable|provider_unavailable/);
      } else if (status === 200) {
        // Shape B: 200 with non-zero exit AND stderr signal.
        const body = await dead.json();
        expect(
          body.exitCode,
          "exec against dead container must report non-zero exit"
        ).not.toBe(0);
        expect(
          body.stderr ?? "",
          "stderr should mention the container is gone (docker-style)"
        ).toMatch(/no such container|not running|not found/i);
        // And the original command's stdout must NOT have happened.
        expect(
          body.stdout ?? "",
          "stdout must not contain the echo payload — the container is gone"
        ).not.toContain("should-not-run");
      } else {
        // Any other status code is a regression — surface it explicitly.
        throw new Error(
          `unexpected status ${status} for exec against a dead container; expected 200 (non-zero exit) or 5xx`
        );
      }
    } finally {
      // Destroy via the API — even if the container is already gone, the
      // sandbox should drop its entry. This recovers capacity.
      await request.delete(`/api/open-swe/sandbox/workspaces/${ws.id}`);
    }

    // Status + body diagnostics — round-8 CI showed `capAfter.used` was
    // `undefined`, meaning the response body lacked the `used` field. That
    // only happens when the endpoint returned the error shape `{error, code}`
    // from sandboxErrorToResponse. Capturing status + raw body here so the
    // NEXT failure tells us exactly which error path fired.
    const capRes = await request.get("/api/open-swe/sandbox/capacity");
    const capStatus = capRes.status();
    const capRaw = await capRes.text();
    expect(
      capStatus,
      `capacity endpoint returned ${capStatus}: ${capRaw}`
    ).toBe(200);
    const capAfter = JSON.parse(capRaw) as { used?: number };
    expect(
      capAfter.used,
      `capacity body missing 'used' — body was: ${capRaw}`
    ).toBeDefined();
    // Capacity must be EXACTLY one less than the snapshot we took right after
    // creating ws (capBefore was read after create, so it includes the slot
    // that we then destroyed). `<=` would have allowed a 1-slot leak to pass.
    expect(capAfter.used).toBe(capBefore.used - 1);

    // Belt-and-braces: the container itself must be gone from docker (which
    // confirms cleanup at the daemon level, not just the in-memory map).
    const stillThere = dockerPs(["--filter", `name=${containerName}`]);
    expect(stillThere, `container ${containerName} must be gone`).toBe("");
  });
});

/**
 * THE FIX ABOVE IS UNWITNESSED WITHOUT THESE.
 *
 * The whole point of #736 is that a cleanup assertion must be able to tell
 * "docker answered, and the answer was none" from "docker never answered".
 * Both produce an empty string; only the status distinguishes them. So the
 * repair is only real if the not-answered case FAILS — and asserting that
 * requires a docker that cannot answer, which is why `runDocker` takes its
 * binary as a parameter.
 *
 * All three run without a Docker daemon: `false` and `true` stand in for a
 * docker that answers badly and one that answers cleanly. They therefore also
 * hold in an environment where the sandbox tests themselves would skip, which
 * is the environment in which the old bug was invisible.
 *
 * The third case is the companion that stops this from being a suite that only
 * knows how to refuse: a successful call returning no containers must still
 * return "", or the fix would have traded a false green for a false red.
 */
test.describe("docker CLI verdicts are not discarded (#736)", () => {
  test("DOCKER-CLI-01: a docker that cannot be run FAILS, rather than reading as clean", () => {
    expect(() =>
      dockerPs(["--filter", "name=anything"], "docker-not-installed-here")
    ).toThrow(/could not be run/);
  });

  test("DOCKER-CLI-02: a docker that exits non-zero FAILS, and says what it exited with", () => {
    // `false` ignores its arguments and exits 1 — a stand-in for docker
    // rejecting the invocation, which the old `|| true` turned into 0.
    let message = "";
    try {
      dockerPs(["--filter", "name=anything"], "false");
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message, "a non-zero exit must be reported, not swallowed").toMatch(
      /exited 1/
    );
  });

  test("DOCKER-CLI-03: THE COMPANION — a clean answer of `no containers` is still empty", () => {
    // `true` exits 0 with no stdout: docker answered, and the answer was none.
    // Without this case, a helper that threw unconditionally would pass both
    // tests above and break every real cleanup assertion in this file.
    expect(dockerPs(["--filter", "name=anything"], "true")).toBe("");
  });
});
