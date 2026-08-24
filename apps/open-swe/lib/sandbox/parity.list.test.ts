/**
 * PROVIDER PARITY — list().
 *
 * Fourth and final parity suite: with this, every method on the adapter surface is covered
 * by a body that runs against BOTH providers.
 *
 * WHY list() IS NOT TRIVIAL
 * It looks like the least interesting method — return the workspaces — but it is the one
 * with the sharpest failure-mode question: what happens when ONE record is bad?
 *
 * docker builds the list from its own in-memory Map, so a malformed record is impossible.
 * blazing maps every record from the API through `toWorkspace`, which THROWS
 * `create_failed` when `sandbox_id` is missing. One bad record therefore fails the WHOLE
 * call — a caller listing 50 healthy workspaces gets an exception instead of 49 plus a gap.
 *
 * That is an all-or-nothing choice, and it is worth pinning deliberately rather than
 * inheriting it from whichever `.map()` happened to be written first.
 */

import { describe, expect, it } from "vitest";
import { BlazingSandbox } from "./blazing-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import type { SandboxWorkspace, SandboxWorkspaceList } from "./types";

interface ProviderCase {
  name: "blazing" | "docker";
  make(opts?: { seed?: number; malformed?: boolean }): {
    create(): Promise<SandboxWorkspace>;
    list(): Promise<SandboxWorkspaceList>;
    destroy(id: string): Promise<void>;
  };
}

const blazingCase: ProviderCase = {
  name: "blazing",
  make(opts = {}) {
    const store = new Map<string, Record<string, unknown>>();
    let n = 0;
    const rec = (id: string) => ({
      sandbox_id: id,
      container_id: `c-${id}`,
      state: "ready",
      image: "node:22-alpine",
      created_at: new Date().toISOString(),
      label: null,
      host: null,
    });
    for (let i = 0; i < (opts.seed ?? 0); i++) {
      const id = `seed-${++n}`;
      store.set(id, rec(id));
    }

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && u.endsWith("/v1/workspace")) {
        const id = `blz-${++n}`;
        store.set(id, rec(id));
        return json(store.get(id));
      }
      if (method === "GET" && u.endsWith("/v1/workspaces")) {
        const items = [...store.values()];
        // A single record missing sandbox_id — schema drift, a partial write, a bug
        // upstream. The question is whether it costs the caller this one entry or all of
        // them.
        if (opts.malformed)
          items.push({ container_id: "orphan", state: "ready" });
        return json({ workspaces: items });
      }
      if (method === "DELETE") {
        const id = decodeURIComponent(u.split("/v1/workspace/")[1] ?? "");
        store.delete(id);
        return new Response(null, { status: 204 });
      }
      return json({ detail: "unexpected" }, 500);
    }) as unknown as typeof fetch;

    return new BlazingSandbox({ baseUrl: "http://blazing.test", fetchFn });
  },
};

const dockerCase: ProviderCase = {
  name: "docker",
  make(opts = {}) {
    const exec = (async (args: string[]) => {
      if (args[0] === "rm") {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return {
        exitCode: 0,
        stdout: `cid-${Math.random().toString(16).slice(2, 10)}`,
        stderr: "",
        timedOut: false,
      };
    }) as never;

    const sandbox = new DockerSandbox({ exec, maxWorkspaces: 16 });
    const reg = (sandbox as unknown as { workspaces: Map<string, unknown> })
      .workspaces;
    for (let i = 0; i < (opts.seed ?? 0); i++) {
      const id = `seed-${i + 1}`;
      reg.set(id, {
        id,
        containerId: `c-${id}`,
        containerName: `n-${id}`,
        provider: "docker",
        status: "ready",
        image: "node:22-alpine",
        createdAt: new Date().toISOString(),
        execTimeoutMs: 30_000,
      });
    }
    // NOTE: docker cannot be given a malformed record — it builds the list from its own
    // Map, which only it writes. `opts.malformed` is therefore a no-op here, and that
    // asymmetry is itself the finding: only the remote provider can be fed bad data.
    return sandbox;
  },
};

const PROVIDERS: ProviderCase[] = [blazingCase, dockerCase];

describe.each(PROVIDERS)("list parity — $name", (provider) => {
  it("returns an empty ARRAY when there are no workspaces, never null/undefined", async () => {
    // Callers iterate the result directly. A provider returning null forces a defensive
    // `?? []` at every call site — the kind of per-provider papercut this suite exists to
    // eliminate.
    const got = await provider.make().list();

    expect(Array.isArray(got)).toBe(true);
    expect(got).toHaveLength(0);
  });

  it("every entry is tagged with this provider", async () => {
    const got = await provider.make({ seed: 3 }).list();

    expect(got).toHaveLength(3);
    for (const ws of got) {
      expect(ws.provider).toBe(provider.name);
      expect(ws.id).toBeTruthy();
    }
  });

  it("reflects create and destroy", async () => {
    const sandbox = provider.make({ seed: 1 });
    expect(await sandbox.list()).toHaveLength(1);

    const made = await sandbox.create();
    const after = await sandbox.list();
    expect(after).toHaveLength(2);
    expect(after.map((w) => w.id)).toContain(made.id);

    await sandbox.destroy(made.id);
    const final = await sandbox.list();
    expect(final).toHaveLength(1);
    expect(final.map((w) => w.id)).not.toContain(made.id);
  });

  it("ids are unique", async () => {
    const got = await provider.make({ seed: 4 }).list();
    expect(new Set(got.map((w) => w.id)).size).toBe(got.length);
  });
});

// ---------------------------------------------------------------------------
// Partial-failure semantics. Only a remote provider can be FED a malformed record, but both
// providers must REPORT their completeness — so the contract is asserted on both, and
// docker's answer being trivially 0 is the point, not a gap.
// ---------------------------------------------------------------------------
describe("list partial-failure semantics", () => {
  // RESOLVED 2026-08-24 — skip-and-log. See PARITY.md § "RESOLVED — `list` partial-failure
  // semantics". `list()` drops records it cannot parse, counts them, and reports the count
  // on the returned array; it does NOT fail the whole call.
  //
  //   docker : cannot be fed a malformed record (builds the list from its own Map)
  //   blazing: skips the bad record, keeps the rest, reports droppedCount
  //
  // WHY THIS ASSERTS IDENTITY AND A DROP COUNT, NOT A LENGTH.
  // The original assertion was `toHaveLength(2)` + every id truthy. That is a PROXY: if
  // `opts.malformed` ever silently stopped applying, the fake yields exactly 2 good records
  // and the assertion passes having proven nothing — the same shape as the iteration-2
  // mutation that never applied. A length check cannot tell "dropped the bad one" from
  // "there was never a bad one". So: pin WHICH records survived, and require positive
  // evidence that a drop actually happened.
  it("blazing — one malformed record costs that record, not the listing", async () => {
    const sandbox = blazingCase.make({ seed: 2, malformed: true });

    const got = await sandbox.list();

    // Identity of survivors, not their count.
    expect(got.map((w) => w.id).sort()).toEqual(["seed-1", "seed-2"]);
    // Positive evidence the malformed record was present AND was dropped. Without this the
    // test passes when the fake stops producing a malformed record at all.
    expect(got.droppedCount).toBe(1);
  });

  it("blazing — a clean listing reports droppedCount 0, not undefined", async () => {
    // Guards the inverse error: a `droppedCount` that is only ever set on the sad path
    // makes `?? 0` necessary at every call site and hides the difference between
    // "nothing dropped" and "this provider does not report".
    const got = await blazingCase.make({ seed: 2 }).list();

    expect(got.map((w) => w.id).sort()).toEqual(["seed-1", "seed-2"]);
    expect(got.droppedCount).toBe(0);
  });

  it("docker — list is never incomplete", async () => {
    // Docker builds the list from its own Map, so incompleteness is impossible by
    // construction rather than merely unobserved. Asserting it keeps the contract
    // symmetric: every provider reports the field, and docker's answer is always 0.
    const got = await dockerCase.make({ seed: 3, malformed: true }).list();

    expect(got).toHaveLength(3);
    expect(got.droppedCount).toBe(0);
  });
});
