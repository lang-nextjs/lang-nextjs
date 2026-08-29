import { createDeepAgentsResumeHandler } from "@deepagents-nextjs/server";

/**
 * MOUNTED AT THE STATIC PATH, NOT `[resumeId]/` (#361).
 *
 * `useDeepAgentsChat` builds `${resumeEndpoint}?resumeId=${id}` — a QUERY
 * STRING (packages/react/src/hook.ts:170) — and this app passes
 * `resumeEndpoint: "/api/chat/stream/resume"`. A route at `resume/[resumeId]/`
 * matches only `/api/chat/stream/resume/<id>`, so Next never invoked the
 * handler and every real auto-GET 404'd. It had done so since reconnect landed.
 *
 * BOTH HALVES ARE REQUIRED AND STOPPING AT ONE IS THE EASY MISTAKE. Teaching
 * the handler to read `?resumeId=` does nothing while no route matches the
 * address, because a 404 from an unreachable path and a 404 from a handler
 * rejecting the shape are INDISTINGUISHABLE FROM THE CLIENT. The first fix of
 * this bug changed the handler, passed its unit test, and was still broken.
 *
 * Nothing noticed for as long as it did because every reconnect spec stubs this
 * endpoint, and the only page that enables reconnect here is a test harness.
 */

export const dynamic = "force-dynamic";

export const GET = createDeepAgentsResumeHandler();
