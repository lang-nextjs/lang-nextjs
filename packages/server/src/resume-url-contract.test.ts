/**
 * THE HOOK'S URL AND THIS HANDLER'S ROUTE MUST AGREE.
 *
 * They did not, and nothing said so. `useDeepAgentsChat` builds
 * `${resumeEndpoint}?resumeId=${id}` (packages/react/src/hook.ts:170) and
 * documents "handler accepts ?resumeId=<id>" (line 63), while this handler read
 * only a path param. So every real auto-GET 404'd, in apps/example too, since
 * reconnect landed.
 *
 * WHY A UNIT TEST AND NOT ONLY AN E2E. Every reconnect e2e stubs this endpoint
 * for isolation — four `page.route("**\/api/chat/stream/resume**")` sites in
 * e2e/shared/reconnect.spec.ts alone — which is defensible there and is exactly
 * why the disagreement survived. A stub proves the client SENT something; only
 * the real handler proves anything ANSWERS. This file owns that property so no
 * e2e has to stop being isolated to carry it.
 *
 * The expected URL is not typed by hand: it is built the way the hook builds it,
 * so a change to either side fails here rather than drifting apart quietly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { NextRequest } from "next/server";
import { createDeepAgentsResumeHandler } from "./reconnect";

const ENDPOINT = "/api/chat/stream/resume";
const ID = "conversation-42";

/** Exactly the construction in packages/react/src/hook.ts:167-171. */
function urlTheHookBuilds(endpoint: string, resumeId: string): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}resumeId=${resumeId}`;
}

const GET = createDeepAgentsResumeHandler();
const req = (path: string) => new NextRequest(`http://localhost${path}`);

beforeEach(() => vi.stubEnv("ENABLE_STREAM_RECONNECT", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("resume URL contract", () => {
  it("answers the URL the hook actually builds", async () => {
    const res = await GET(req(urlTheHookBuilds(ENDPOINT, ID)));
    // 204 = "no such live stream", which is the healthy answer for an id that
    // was never registered. What must NOT happen is the handler failing to see
    // an id at all — that was the bug, and it surfaced as a 404 from Next
    // because no route matched the query-string shape.
    expect(
      res.status,
      "the handler did not recognise the id in the URL its own client sends"
    ).toBe(204);
  });

  it("still answers the path form apps/example mounts", async () => {
    // The control that stops the fix trading one silent 404 for another.
    const res = await GET(req(`${ENDPOINT}/${ID}`), {
      params: Promise.resolve({ resumeId: ID }),
    });
    expect(res.status).toBe(204);
  });

  it("a request naming NO stream is a 400, not a 204", async () => {
    // 204 would be indistinguishable from "that stream is finished", so a
    // client with a broken URL would look exactly like one whose stream ended
    // — which is how this bug hid. The distinction is the point.
    const res = await GET(req(ENDPOINT));
    expect(res.status).toBe(400);
  });

  it("the disabled gate still wins over both forms", async () => {
    vi.stubEnv("ENABLE_STREAM_RECONNECT", "false");
    expect((await GET(req(urlTheHookBuilds(ENDPOINT, ID)))).status).toBe(503);
    expect(
      (await GET(req(`${ENDPOINT}/${ID}`), { params: Promise.resolve({ resumeId: ID }) })).status
    ).toBe(503);
  });
});

/**
 * THE OTHER HALF, and it is the half that is easy to stop before.
 *
 * Teaching the handler to read `?resumeId=` does nothing if no ROUTE matches
 * the address the client asks for. A route at `resume/[resumeId]/` answers only
 * `/resume/<id>`, so Next never invokes the handler however it is written — and
 * the first fix of this bug did exactly that: changed the handler, passed the
 * cases above, and was still broken. A curl against a running server caught it;
 * nothing in this file could have.
 *
 * A 404 FROM AN UNREACHABLE ADDRESS AND A 404 FROM A HANDLER REJECTING THE
 * SHAPE ARE INDISTINGUISHABLE FROM THE CLIENT, which is why one fix looks like
 * both. So the mount is asserted too: no app may mount this handler under a
 * dynamic segment.
 *
 * It reads the filesystem rather than importing anything, because the property
 * is about WHERE a file sits, and both apps had it wrong at once.
 */
describe("resume route MOUNT", () => {
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

  /** Every file under apps/ that mounts the resume handler. */
  function mountSites(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "route.ts" || e.name === "route.tsx") {
          if (readFileSync(full, "utf8").includes("createDeepAgentsResumeHandler")) {
            out.push(full.slice(repoRoot.length + 1).split(sep).join("/"));
          }
        }
      }
    };
    walk(join(repoRoot, "apps"));
    return out.sort();
  }

  it("every app mounts the resume handler at a STATIC path", () => {
    const sites = mountSites();

    // ANTI-VACUITY. "No dynamic mounts out of zero mounts" is the shape of the
    // failure, not evidence against it — if this walk finds nothing, the
    // assertion below is about an empty list.
    expect(
      sites.length,
      "found no app mounting createDeepAgentsResumeHandler — this check has no subject"
    ).toBeGreaterThan(0);

    const dynamic = sites.filter((p) => /\[[^\]]+\]/.test(p));
    expect(
      dynamic,
      "these mount the resume handler under a dynamic segment, so Next only routes " +
        "`/resume/<id>` to them — but the hook requests `/resume?resumeId=<id>`, and " +
        "the auto-GET 404s at mount however the handler is written"
    ).toEqual([]);
  });
});
