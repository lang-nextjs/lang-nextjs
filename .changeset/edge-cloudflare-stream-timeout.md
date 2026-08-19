---
"@deepagents-nextjs/edge": minor
---

Add `streamTimeoutMs` option to `createCloudflareHandler` for bounding total stream duration on Cloudflare Workers.

When set, the handler aborts the backend connection if the configured limit is exceeded: a pre-stream timeout returns HTTP 504, and a mid-stream timeout errors the `ReadableStream` instead of leaking an open reader. The option defaults to `undefined`, so existing handlers are unaffected unless they opt in. Recommended to keep it below the Worker CPU limit (30s on the free tier).

The README now documents Cloudflare Worker tier requirements (128MB memory, 30s CPU, ~10s TTFB) and the new option.
