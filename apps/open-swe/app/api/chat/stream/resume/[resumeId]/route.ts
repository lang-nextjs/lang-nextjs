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
 * GATED SERVER-SIDE, and the gate is the reason this is not enough on its own:
 * `createDeepAgentsResumeHandler` answers 503 unless ENABLE_STREAM_RECONNECT is
 * "true", so mounting the route without setting that variable gives a feature
 * that is wired, reachable, and inert. e2e.yml sets it on open-swe's server for
 * exactly that reason.
 */
export const dynamic = "force-dynamic";

export const GET = createDeepAgentsResumeHandler();
