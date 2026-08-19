/**
 * PROVIDER PARITY — create / get / destroy lifecycle.
 *
 * Companion to parity.executeTool.test.ts. Same shape, same rule: the body runs against
 * BOTH providers and asserts only on the contract, never on wire details.
 *
 * WHY THESE THREE TOGETHER
 * `create` has the largest behavioural surface after `executeTool`, and `destroy` is where
 * cleanup divergence hides. They are tested as a round trip rather than in isolation because
 * the property that actually matters to an integrator is a sequence — create it, see it,
 * destroy it, stop seeing it — and a provider can get each step individually right while
 * getting the sequence wrong (e.g. destroying the container but leaking the registry entry,
 * so `get` keeps returning a workspace that no longer exists).
 *
 * THE BLAZING FAKE IS STATEFUL ON PURPOSE. Docker tracks workspaces in an in-memory Map, so
 * its round trip is real. If the Blazing fake just returned canned 200s, its round-trip test
 * would pass without ever exercising a lifecycle, and the two providers would not be under
 * the same test. The fake therefore keeps a Map and answers GET/DELETE from it — the minimum
 * that makes the assertion mean the same thing on both sides.
 */

import { describe, expect, it } from "vitest";
import { BlazingSandbox } from "./blazing-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import { SandboxError } from "./types";
import type { SandboxConfig, SandboxWorkspace } from "./types";

interface ProviderCase {
  name: "blazing" | "docker";
  /** A provider backed by a stateful fake, plus knobs for the failure cases. */
  make(opts?: { atCapacity?: boolean; destroyFails?: boolean }): {
    create(config?: SandboxConfig): Promise<SandboxWorkspace>;
    get(id: string): Promise<SandboxWorkspace | null>;
    destroy(id: string): Promise<void>;
  };
}

const blazingCase: ProviderCase = {
  name: "blazing",
  make(opts = {}) {
    const store = new Map<string, Record<string, unknown>>();
    let n = 0;

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const id = decodeURIComponent(
        u.split("/v1/workspace/")[1]?.split("/")[0] ?? ""
      );

      if (method === "POST" && u.endsWith("/v1/workspace")) {
        if (opts.atCapacity) return json({ detail: "at capacity" }, 429);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const wid = `blz-${++n}`;
        // Field names come from BlazingWorkspaceRecord, not invention: sandbox_id / state /
        // container_id. Getting this wrong is how a fake ends up testing itself.
        store.set(wid, {
          sandbox_id: wid,
          container_id: `c-${wid}`,
          state: "ready",
          image: body.image ?? "node:22-alpine",
          created_at: new Date().toISOString(),
          label: body.label ?? null,
          host: null,
        });
        return json(store.get(wid));
      }
      if (method === "GET" && id) {
        const rec = store.get(id);
        return rec ? json(rec) : json({ detail: "not found" }, 404);
      }
      if (method === "DELETE" && id) {
        // 204 for an unknown id, NOT 404. This is the documented behaviour of the real
        // Blazing API ("destroy is idempotent — 204 even for unknown workspace", see
        // blazing-sandbox.test.ts). An earlier version of this fake returned 404 because I
        // assumed it did; that assumption made the not_found parity assertion below pass on
        // both providers and hid a genuine divergence. A fake that encodes the author's
        // guess tests the guess.
        if (!store.has(id)) return new Response(null, { status: 204 });
        if (opts.destroyFails) return json({ detail: "destroy blew up" }, 500);
        store.delete(id);
        return new Response(null, { status: 204 });
      }
      return json({ detail: "unexpected call" }, 500);
    }) as unknown as typeof fetch;

    return new BlazingSandbox({ baseUrl: "http://blazing.test", fetchFn });
  },
};

const dockerCase: ProviderCase = {
  name: "docker",
  make(opts = {}) {
    const exec = (async (args: string[]) => {
      // `docker rm -f` is the destroy path; everything else is create/inspect.
      if (args[0] === "rm") {
        return opts.destroyFails
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "destroy blew up",
              timedOut: false,
            }
          : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return {
        exitCode: 0,
        stdout: `cid-${Math.random().toString(16).slice(2, 10)}`,
        stderr: "",
        timedOut: false,
      };
    }) as never;

    return new DockerSandbox({
      exec,
      maxWorkspaces: opts.atCapacity ? 0 : 8,
    });
  },
};

const PROVIDERS: ProviderCase[] = [blazingCase, dockerCase];

describe.each(PROVIDERS)("lifecycle parity — $name", (provider) => {
  it("create returns a ready workspace tagged with its own provider", async () => {
    const sandbox = provider.make();
    const ws = await sandbox.create();

    expect(ws.id).toBeTruthy();
    expect(ws.status).toBe("ready");
    expect(ws.provider).toBe(provider.name);
    expect(typeof ws.createdAt).toBe("string");
  });

  it("round trip: create -> get finds it -> destroy -> get returns null", async () => {
    // The sequence, not the steps. A provider can destroy the container and still leak the
    // registry entry, leaving `get` reporting a workspace that no longer exists.
    const sandbox = provider.make();
    const ws = await sandbox.create();

    const found = await sandbox.get(ws.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(ws.id);

    await sandbox.destroy(ws.id);

    const gone = await sandbox.get(ws.id);
    expect(gone).toBeNull();
  });

  it("get returns null for an unknown id rather than throwing", async () => {
    // null, not an exception: callers branch on existence constantly, and a provider that
    // throws here forces provider-specific try/catch at every call site.
    const sandbox = provider.make();
    await expect(sandbox.get("nope-does-not-exist")).resolves.toBeNull();
  });

  // KNOWN DIVERGENCE — destroy idempotency. Skipped, not deleted, pending a decision.
  //
  //   docker  : destroy(unknown) THROWS not_found
  //   blazing : destroy(unknown) RESOLVES — the API returns 204 for unknown ids, and
  //             blazing-sandbox.test.ts pins that as the intended contract
  //
  // Both are defensible. HTTP DELETE is specified as idempotent, so blazing follows the
  // stricter reading; docker's throw is more informative to a caller that believed the
  // workspace existed. What is NOT defensible is the two disagreeing silently, because a
  // caller that wraps destroy in try/catch behaves differently per backend.
  //
  // Resolving it means picking one and changing the other — a contract decision, so it
  // stops here per the loop's guardrails. See PARITY.md "Known divergent".
  it("destroy RESOLVES for an unknown id — idempotent on both providers", async () => {
    // RESOLVED by quorum Q1=A (5 rounds, unanimous). Was skipped as a known divergence:
    // docker threw not_found, blazing resolved. Docker was the outlier, and blazing could
    // not have matched it — its API returns 204 for both "deleted" and "never existed".
    const sandbox = provider.make();
    await expect(
      sandbox.destroy("nope-does-not-exist")
    ).resolves.toBeUndefined();
  });

  it("create raises at_capacity when the provider is full", async () => {
    const sandbox = provider.make({ atCapacity: true });
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "at_capacity",
    });
  });

  // RESOLVED by quorum Q2=B / IMPL=ii (5 rounds, unanimous). destroy_failed was previously
  // UNREACHABLE on blazing because guardedFetch collapses every 5xx into
  // provider_unavailable. Blazing's destroy() now runs a confirmatory GET after a failed
  // DELETE and raises destroy_failed only when the workspace actually survived — ground
  // truth rather than an HTTP status a proxy could have set.
  it("a failing destroy raises destroy_failed, not a generic error", async () => {
    const sandbox = provider.make({ destroyFails: true });
    const ws = await sandbox.create();

    // ONE call. Asserting twice conflates the failure with the follow-up, because docker
    // deletes the registry entry before checking the exit code — so a second destroy raises
    // not_found rather than destroy_failed. Whether that post-failure registry state should
    // match across providers is a real question, pinned separately below.
    const err = await sandbox.destroy(ws.id).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("destroy_failed");
  });
});
