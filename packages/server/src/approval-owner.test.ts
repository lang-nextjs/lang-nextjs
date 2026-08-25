/**
 * APPROVAL OWNERSHIP (#170) — the owner check is driven by the RECORD, not the wiring.
 *
 * WHAT #170 ACTUALLY IS. The filed title says an approval "can be resolved by anyone who can
 * reach the endpoint". That overstates it: routes are `/api/approval/[approvalId]` and there is
 * no list endpoint, so reaching the endpoint is not sufficient — you need the id. The shipped
 * model is a BEARER CAPABILITY, and it is defensible for an app with no auth. Its real defects
 * were that it was unnamed, fail-open, and unbounded: the registry is one `globalThis` Map with
 * no boundary between concurrent streams.
 *
 * WHAT THIS FIXES, AND WHAT IT DOES NOT. `ownerKey` narrows the capability from "anyone holding
 * the id" to "anyone holding the id AND the creator's key". It is a second bearer token, not
 * authentication. It stops one session resolving another's approval inside a shared process. It
 * does not stop someone who has both values.
 *
 * WHY THE GUARD IS DATA-DRIVEN. Had it been conditional on the consumer passing `authorize`, or
 * implemented in the app's route file, a fork that kept packages/server and wrote its own route
 * would ship the gate UNGUARDED while LOOKING guarded — the package still exports an authorize
 * hook. A property enforced at the call site is one a fork can drop without noticing. The test
 * named "...with NO authorize wired..." is the one that pins that, and it is the point of #170.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createApprovalRoutes } from "./approval-routes";
import { createSseProxyHandler } from "./handler";
import { neutralAdapter } from "./core-test-adapters";
import {
  registerApproval,
  peekApproval,
  cleanupApproval,
  type PendingApproval,
} from "./approval-registry";

const OWNER = "sess-owner-4f2a";
const OTHER = "sess-other-9c7b";

function makeApproval(
  id: string,
  overrides: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    approvalId: id,
    toolCallId: `tc-${id}`,
    toolName: "bash_execute",
    input: { command: "echo test" },
    status: "waiting",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** A request carrying an optional owner header. */
function req(
  method: string,
  id: string,
  owner?: string,
  body?: unknown
): {
  request: NextRequest;
  context: { params: Promise<{ approvalId: string }> };
} {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (owner !== undefined) headers["x-approval-owner"] = owner;
  const request = new NextRequest(`http://localhost/api/approval/${id}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, context: { params: Promise.resolve({ approvalId: id }) } };
}

const ids: string[] = [];
const track = (id: string) => {
  ids.push(id);
  return id;
};
afterEach(() => {
  for (const id of ids.splice(0)) cleanupApproval(id);
  vi.restoreAllMocks();
});

describe("approval ownership — the guard travels with the record", () => {
  it("GUARD: the fixture really does stamp an ownerKey", () => {
    // Without this, every 403 below could come from a record that has no owner at all and the
    // suite would be asserting nothing. Same shape as the walk-found-nothing guards elsewhere.
    const id = track("own-guard-01");
    registerApproval(makeApproval(id, { ownerKey: OWNER }));
    expect(peekApproval(id)?.ownerKey).toBe(OWNER);
  });

  it("THE POINT OF #170: rejects a mismatched owner with NO authorize wired", async () => {
    // Zero-arg factory — exactly what a fork gets if it wires nothing. The check must still
    // apply, because it is driven by the record rather than by this call site.
    const id = track("own-nowire-01");
    registerApproval(makeApproval(id, { ownerKey: OWNER }));
    const routes = createApprovalRoutes();

    const { request, context } = req("POST", id, OTHER, { decision: "approve" });
    const res = await routes.POST(request, context);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "approval belongs to another session",
    });
    // ...and the record is untouched. A rejected resolve must not half-apply.
    expect(peekApproval(id)?.status).toBe("waiting");
  });

  it("rejects a MISSING owner header when the record has one", async () => {
    const id = track("own-missing-01");
    registerApproval(makeApproval(id, { ownerKey: OWNER }));
    const routes = createApprovalRoutes();

    const { request, context } = req("POST", id, undefined, {
      decision: "approve",
    });
    const res = await routes.POST(request, context);

    expect(res.status).toBe(403);
    expect(peekApproval(id)?.status).toBe("waiting");
  });

  it("accepts the matching owner", async () => {
    const id = track("own-match-01");
    registerApproval(makeApproval(id, { ownerKey: OWNER }));
    const routes = createApprovalRoutes();

    const { request, context } = req("POST", id, OWNER, { decision: "approve" });
    const res = await routes.POST(request, context);

    expect(res.status).toBe(200);
    expect(peekApproval(id)?.status).toBe("approved");
  });

  it("GET is guarded too, not just POST", async () => {
    // The status endpoint leaks toolName and input shape. Guarding only the mutating verb
    // would make the record readable by anyone holding the id.
    const id = track("own-get-01");
    registerApproval(makeApproval(id, { ownerKey: OWNER }));
    const routes = createApprovalRoutes();

    const { request, context } = req("GET", id, OTHER);
    const res = await routes.GET(request, context);

    expect(res.status).toBe(403);
  });

  it("BACKWARD COMPAT: a record with no ownerKey is still resolvable by id alone", async () => {
    // The pre-#170 contract. Wiring the header is opt-in, so an app that sends nothing keeps
    // working — the alternative would break every existing consumer on upgrade.
    const id = track("own-legacy-01");
    registerApproval(makeApproval(id)); // no ownerKey
    const routes = createApprovalRoutes();

    const { request, context } = req("POST", id, undefined, {
      decision: "approve",
    });
    const res = await routes.POST(request, context);

    expect(res.status).toBe(200);
    expect(peekApproval(id)?.status).toBe("approved");
  });

  it("a denied caller cannot move the record via the lazy TTL", async () => {
    // getApproval() flips an expired `waiting` to `timeout` on read. Authorization reads
    // through peekApproval() so a denied caller cannot trigger that transition — an
    // authorization decision must not mutate its subject.
    const id = track("own-ttl-01");
    registerApproval(
      makeApproval(id, { ownerKey: OWNER, expiresAt: Date.now() - 1 })
    );
    const routes = createApprovalRoutes();

    const { request, context } = req("GET", id, OTHER);
    expect((await routes.GET(request, context)).status).toBe(403);
    expect(peekApproval(id)?.status).toBe("waiting");
  });

  it("END TO END: the handler stamps x-approval-owner onto the approval it registers", async () => {
    // The unit tests above register approvals by hand, so they prove the CHECK works and say
    // nothing about whether the header ever reaches a record. Without this, the whole feature
    // could be inert in production and every test above would still pass.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"type":"tool-input-start","toolCallId":"tc-e2e","toolName":"bash_execute","input":{"command":"ls"}}\n\n' +
                  'data: {"type":"finish"}\n\n'
              )
            );
            c.close();
          },
        }),
      } as never)
    );

    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      adapter: neutralAdapter,
      approvalGating: {
        getApprovalConfig: () => ({ require: true }),
        drainGraceMs: 0,
      },
    });

    const request = {
      headers: new Headers({ "x-approval-owner": OWNER }),
      arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
    } as never;

    const response = (await handler(request)) as unknown as Response;
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let body = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += dec.decode(value, { stream: true });
    }

    const line = body
      .split("\n")
      .find((l) => l.includes('"type":"data-approval-required"'));
    expect(line, "the gate must have fired, or this proves nothing").toBeDefined();
    const approvalId = JSON.parse(line!.slice(6)).data.id as string;
    track(approvalId);

    expect(peekApproval(approvalId)?.ownerKey).toBe(OWNER);
  });
});
