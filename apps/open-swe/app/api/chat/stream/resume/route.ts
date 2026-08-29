import { createDeepAgentsResumeHandler } from "@deepagents-nextjs/server";

/**
 * Resume a stream this app was serving when the socket died (#361).
 *
 * open-swe had no such route: `app/api/chat/` held `stream/` and `tools/` and
 * nothing else, so three of the four shared reconnect specs asserted behaviour
 * this app has never had, and #335 was right to decline them rather than write
 * specs that pass or fail for unrelated reasons.
 *
 * The handler is the SAME one apps/example mounts — reconnection is transport,
 * and transport lives in packages/server. This file exists to mount it at a URL
 * open-swe's client can reach, not to reimplement anything.
 *
 * MOUNTED AT THE STATIC PATH, NOT `[resumeId]/`, because that is the URL the
 * client asks for. `useDeepAgentsChat` builds
 * `${resumeEndpoint}?resumeId=${id}` (packages/react/src/hook.ts:170) — a QUERY
 * STRING — and a route at `resume/[resumeId]/` matches only
 * `/api/chat/stream/resume/<id>`. Next never invokes the handler, the auto-GET
 * 404s at mount, and every page that mounts the chat surface goes down with it.
 *
 * That is not hypothetical: it is what the first attempt at this shipped, and
 * it took 47 open-swe specs red in one run. apps/example mounts `[resumeId]/`
 * and has the same mismatch — its reconnect has never made a successful request
 * to its own resume route, because the only page that enables it is a harness
 * whose spec stubs the endpoint.
 *
 * GATED SERVER-SIDE, and the gate is the reason this is not enough on its own:
 * `createDeepAgentsResumeHandler` answers 503 unless ENABLE_STREAM_RECONNECT is
 * "true", so mounting the route without setting that variable gives a feature
 * that is wired, reachable, and inert. e2e.yml sets it on open-swe's server for
 * exactly that reason.
 */
export const dynamic = "force-dynamic";

export const GET = createDeepAgentsResumeHandler();
