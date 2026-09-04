/*
 * RECORDED, NOT LIVE — the two verdict-destroying sites as they stood in
 * e2e/rungs/open-swe/open-swe-sandbox.spec.ts at 659cc4da68b75afdc523e037a00683ca524b4bd3.
 *
 * DEV3's #738 rewrites both to an argv form with the status read explicitly, so
 * a rejection corpus pointing at the live file would lose its subject the moment
 * that lands — and a fixture whose premise is "this defect is still unfixed" has
 * an expiry date on it. Recorded here instead, pinned to a sha, so the checker's
 * ability to REFUSE survives the defect being repaired.
 *
 * Taking it from `git show` at run time was the other option and is worse: it
 * makes the proof depend on history being present, and CI shallow-clones.
 *
 * WHY THESE TWO CANNOT BE REPAIRED IN PLACE the way the sixteen compliant
 * `|| true` sites can: every one of those branches on the value, so "empty" and
 * "succeeded" are different outcomes to them. Here the assertion's PASS state
 * and its COULD-NOT-COMPUTE state are the same string — `""` — so there is no
 * branch to add without changing what is asserted.
 *
 * Not swept by the live checker: scripts/__fixtures__ is excluded by name,
 * because its contents are defective BY CONSTRUCTION.
 */
      ).toEqual([]);

      // Verifiable cleanup: list containers that this test created by name.
      // If the sandbox API said it deleted them, `docker ps -a` must agree.
      const containerNames = created.map((w) => w.containerName).join("|");
      const ps = execSync(
        `docker ps -aq --filter "label=open-swe.sandbox=1" --filter "name=${containerNames}" 2>/dev/null || true`,
        { encoding: "utf-8" }
      ).trim();
      expect(
        ps,
        `no container from this run may remain after cleanup; leaked: ${ps}`
      ).toBe("");

    // creating ws (capBefore was read after create, so it includes the slot
    // that we then destroyed). `<=` would have allowed a 1-slot leak to pass.
    expect(capAfter.used).toBe(capBefore.used - 1);

    // Belt-and-braces: the container itself must be gone from docker (which
    // confirms cleanup at the daemon level, not just the in-memory map).
    const stillThere = execSync(
      `docker ps -aq --filter "name=${containerName}" 2>/dev/null || true`,
      { encoding: "utf-8" }
    ).trim();
    expect(stillThere, `container ${containerName} must be gone`).toBe("");
  });
});
