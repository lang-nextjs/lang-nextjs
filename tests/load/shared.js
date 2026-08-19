// Shared constants and helpers for all load tests
// Import this in each test script

import http from 'k6/http';

export const CONFIG = {
  // Target the Next.js open-swe proxy (port 3001 by default)
  // Override via K6_ENV_OPENSWE_URL env var
  OPEN_SWE_URL: __ENV.OPENSWE_URL || 'http://localhost:3001',
  // Target the FastAPI backend directly (port 8001)
  BACKEND_URL: __ENV.BACKEND_URL || 'http://localhost:8001',
  // LangGraph Platform URL (only needed for direct platform tests)
  PLATFORM_URL: __ENV.LANGGRAPH_PLATFORM_URL || 'http://localhost:8000',
  ASSISTANT_ID: __ENV.OPEN_SWE_ASSISTANT_ID || 'open-swe',
  API_KEY: __ENV.LANGGRAPH_API_KEY || '',
  // SSE stream timeout (ms) — stream test will timeout after this
  STREAM_TIMEOUT_MS: 30_000,
  // Number of concurrent streams per VU in the streaming test
  STREAMS_PER_VU: 5,
};

/** Build HTTP headers for LangGraph Platform */
export function platformHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (CONFIG.API_KEY) h['X-Api-Key'] = CONFIG.API_KEY;
  return h;
}

/** Create a run on the LangGraph Platform and return the parsed response */
export function createPlatformRun(task, headers) {
  const url = `${CONFIG.PLATFORM_URL}/runs`;
  const payload = JSON.stringify({ assistant_id: CONFIG.ASSISTANT_ID, input: { task } });
  return http.post(url, payload, { headers });
}

/** Create a run via the open-swe Next.js proxy */
export function createOpenSWERun(task) {
  const url = `${CONFIG.OPEN_SWE_URL}/api/open-swe/runs`;
  const payload = JSON.stringify({ task });
  return http.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
}

/**
 * Consume an SSE stream and measure time-to-first-byte and total duration.
 * Returns the number of SSE messages received.
 */
export function consumeSSEStream(url, timeoutMs = CONFIG.STREAM_TIMEOUT_MS) {
  const res = http.get(url, {
    headers: { Accept: 'text/event-stream' },
    timeout: `${timeoutMs}ms`,
  });

  return {
    status: res.status,
    ttfbMs: res.timings.waiting,  // time to first byte (ms)
    durationMs: res.timings.duration, // total request duration (ms)
    bodyLength: res.body ? res.body.length : 0,
    messageCount: countSSEMessages(res.body),
  };
}

/** Rough SSE message counter */
export function countSSEMessages(body) {
  if (!body) return 0;
  return (body.match(/^data:/gm) || []).length;
}
