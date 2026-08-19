/**
 * createDenoHandler — Deno Deploy SSE proxy handler factory.
 *
 * Usage (two-line consumer setup in Deno Deploy entry point):
 *   import { createDenoHandler } from '@deepagents-nextjs/edge'
 *   const handler = createDenoHandler({ backendUrl: Deno.env.get('BACKEND_URL')!, adapter })
 *   Deno.serve({ port: 3000 }, handler)
 *
 * Uses only Web Streams API — no Node.js imports.
 */
import { SseFrameAccumulator } from "./accumulator";
import type { SseFrame, SseTransform } from "./accumulator";
import type { DenoHandlerOptions } from "./types";

/**
 * Hop-by-hop headers that must not be proxied.
 */
const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Apply a transform pipeline to a frame. Returns null if any transform returns null.
 */
function applyTransforms(
  transforms: SseTransform[],
  frame: SseFrame
): SseFrame | null {
  let current: SseFrame | null = frame;
  for (const t of transforms) {
    if (current === null) return null;
    current = t(current);
  }
  return current;
}

/**
 * Creates a Deno Deploy handler that proxies SSE streams
 * from a DeepAgents backend with configurable transforms.
 *
 * Clean proxy — no default adapter transforms (consumer provides adapter explicitly).
 */
export function createDenoHandler(
  options: DenoHandlerOptions
): (request: Request) => Promise<Response> {
  const allTransforms: SseTransform[] = [
    ...(options.adapter?.transforms ?? []),
    ...(options.transforms ?? []),
  ];

  return async function handler(request: Request): Promise<Response> {
    if (!options.backendUrl) {
      console.error("[deepagents/edge/deno] BACKEND_URL is not set");
      return new Response("Service Unavailable: BACKEND_URL not configured", {
        status: 503,
      });
    }

    // Body-size guard: refuse payloads larger than maxBodyBytes (default 1MB)
    // before reading the full buffer into memory. Prevents unbounded memory
    // growth from a hostile or malformed client. Configurable via
    // options.maxBodyBytes; 0 / negative disables. Default matches the
    // server-side cap for consistency.
    const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    if (maxBodyBytes > 0) {
      const contentLength = request.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          return new Response(
            JSON.stringify({
              error: "Payload too large",
              maxBytes: maxBodyBytes,
            }),
            {
              status: 413,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }
    }

    // Strict per-header validation: reject duplicate single-value headers up-front.
    //
    // The Fetch API combines duplicate header lines on iteration per RFC 7230
    // §3.2.2, with per-header join semantics that do NOT match what most clients
    // intend or what most backends accept:
    //
    //   Header         Join  RFC         Notes
    //   ─────────────  ────  ──────────  ─────────────────────────────────────
    //   Content-Type   ", "  7231 §3.1.1 Malformed — no valid media-type has a comma
    //   Authorization  ", "  RFC 7235    Single auth-scheme + token; comma = bypass attempt
    //
    // We reject with 400 when a STRICT single-value header has a comma. Strict-mode
    // backends (Django, Express strict, FastAPI strict) reject the combined value
    // anyway, so failing closed at the proxy gives a clearer error than letting
    // the backend reject with a generic 400.
    const STRICT_SINGLE_VALUE_HEADERS = ["content-type", "authorization"];
    for (const headerName of STRICT_SINGLE_VALUE_HEADERS) {
      const value = request.headers.get(headerName);
      if (value && value.includes(",")) {
        return new Response(
          JSON.stringify({
            error: "Bad Request",
            message: `Duplicate ${headerName} header is not allowed`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const body = await request.arrayBuffer();
    // Belt-and-braces: re-check after read in case Content-Length was
    // missing or under-stated (some HTTP clients omit it for streamed
    // bodies). Catches the attack a content-length-only check would miss.
    if (maxBodyBytes > 0 && body.byteLength > maxBodyBytes) {
      return new Response(
        JSON.stringify({
          error: "Payload too large",
          maxBytes: maxBodyBytes,
          actual: body.byteLength,
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const forwardedHeaders = new Headers();

    if (options.getToken !== undefined) {
      for (const [key, value] of request.headers) {
        if (
          !HOP_BY_HOP.has(key.toLowerCase()) &&
          key.toLowerCase() !== "authorization"
        ) {
          forwardedHeaders.set(key, value);
        }
      }
      let token: string | null | undefined;
      try {
        token = await options.getToken(request);
      } catch (err) {
        console.error("[deepagents/edge/deno] getToken threw", err);
        return new Response("upstream error", { status: 502 });
      }
      if (token) {
        forwardedHeaders.set("authorization", `Bearer ${token}`);
      }
    } else {
      for (const [key, value] of request.headers) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
          forwardedHeaders.set(key, value);
        }
      }
    }

    let backendResponse: Response;
    try {
      backendResponse = await fetch(options.backendUrl, {
        method: "POST",
        headers: forwardedHeaders,
        body,
      });
    } catch (err) {
      console.error("[deepagents/edge/deno] backend fetch failed", err);
      return new Response("upstream error", { status: 502 });
    }

    if (!backendResponse.body) {
      return new Response(null, { status: backendResponse.status });
    }

    const responseHeaders = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });

    const aiSdkMarker = backendResponse.headers.get(
      "x-vercel-ai-ui-message-stream"
    );
    if (aiSdkMarker) {
      responseHeaders.set("x-vercel-ai-ui-message-stream", aiSdkMarker);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const accumulator = new SseFrameAccumulator();

    const transformedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = backendResponse.body!.getReader();
        try {
          // eslint-disable-next-line no-constant-condition -- loop exits on done
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              for (const frame of accumulator.flush()) {
                const transformed = applyTransforms(allTransforms, {
                  raw: frame,
                });
                if (transformed !== null) {
                  controller.enqueue(encoder.encode(`${transformed.raw}\n\n`));
                }
              }
              controller.close();
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            for (const frame of accumulator.push(chunk)) {
              const transformed = applyTransforms(allTransforms, {
                raw: frame,
              });
              if (transformed !== null) {
                controller.enqueue(encoder.encode(`${transformed.raw}\n\n`));
              }
            }
          }
        } catch (err) {
          console.error("[deepagents/edge/deno] mid-stream error", err);
          controller.error(err);
        }
      },
    });

    return new Response(transformedStream, {
      status: backendResponse.status,
      headers: responseHeaders,
    });
  };
}
