/**
 * createDeepAgentsHandler — SvelteKit SSE proxy handler factory.
 *
 * Usage (two-line consumer setup in +server.ts):
 *   import { createDeepAgentsHandler } from '@deepagents-nextjs/sveltekit'
 *   export const POST = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! })
 *
 * Returns a standard Web API Response (NOT NextResponse). Requires Node.js runtime.
 * Use @sveltejs/adapter-node for deployment.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { SseFrameAccumulator, isFrameOversized } from "./accumulator";
import type { SseFrame, SseTransform } from "./accumulator";
import type { SvelteKitHandlerOptions } from "./types";

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
 * Asserts that the current runtime is Node.js.
 * Must be called inside the handler function (not at module level).
 */
function assertNodeRuntime(): void {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error(
      "@deepagents-nextjs/sveltekit requires Node.js runtime. " +
        "Cloudflare Workers and other edge runtimes are not supported in v1.2. " +
        "Use @sveltejs/adapter-node for your SvelteKit deployment."
    );
  }
}

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
 * Ensure a frame is terminated with exactly one `\n\n` SSE frame
 * terminator. If the frame already ends with `\n\n` (e.g. a transform
 * applied its own terminator), the value is returned verbatim. Otherwise
 * the single `\n\n` terminator is appended. This prevents the
 * "double-terminated" bug where a transform returns a frame already
 * terminated with `\n\n` and the handler unconditionally appends another
 * `\n\n`, producing `\n\n\n\n` gaps between frames that downstream SSE
 * consumers may parse as malformed empty middle frames.
 */
function ensureFrameTerminator(raw: string): string {
  if (raw.endsWith("\n\n")) {
    return raw;
  }
  return `${raw}\n\n`;
}

/**
 * Creates a SvelteKit POST handler that proxies SSE streams
 * from a DeepAgents backend with configurable transforms.
 *
 * The SvelteKit handler is a clean proxy — it applies NO default adapter transforms
 * (unlike the Next.js server handler which applies deepagentsAdapter by default).
 * Consumers provide the adapter explicitly if normalization is needed.
 */
export function createDeepAgentsHandler(
  options: SvelteKitHandlerOptions
): (event: RequestEvent) => Promise<Response> {
  // No default adapter for SvelteKit — consumer provides adapter explicitly
  const allTransforms: SseTransform[] = [
    ...(options.adapter?.transforms ?? []),
    ...(options.transforms ?? []),
  ];

  return async function handler(event: RequestEvent): Promise<Response> {
    // Runtime guard — must be inside handler, not at module level
    assertNodeRuntime();

    // Body-size guard: refuse payloads larger than maxBodyBytes (default 1MB)
    // before reading the full buffer into memory. Prevents unbounded
    // memory growth from a hostile or malformed client. Configurable via
    // options.maxBodyBytes; 0 / negative disables. Default matches the
    // server/remix handler default.
    const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    if (maxBodyBytes > 0) {
      const contentLength = event.request.headers.get("content-length");
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

    const body = await event.request.arrayBuffer();
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
      const value = event.request.headers.get(headerName);
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

    // Build forwarded headers per CONTEXT.md locked decisions
    const forwardedHeaders = new Headers();

    if (options.getToken !== undefined) {
      // getToken provided: apply auth policy
      // Forward non-hop-by-hop client headers, excluding Authorization (getToken controls it)
      for (const [key, value] of event.request.headers) {
        if (
          !HOP_BY_HOP.has(key.toLowerCase()) &&
          key.toLowerCase() !== "authorization"
        ) {
          forwardedHeaders.set(key, value);
        }
      }
      // getToken throws → propagates (not caught here per CONTEXT.md locked decision)
      const token = await options.getToken(event);
      if (token) {
        // Returns non-empty string → inject as Authorization: Bearer {token}
        forwardedHeaders.set("authorization", `Bearer ${token}`);
      }
      // Returns null/undefined/empty string → no Authorization header (fail-open)
    } else {
      // getToken absent → forward all non-hop-by-hop headers as-is
      for (const [key, value] of event.request.headers) {
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
        // @ts-expect-error — Node 18 fetch needs duplex for streaming bodies
        duplex: "half",
      });
    } catch (err) {
      console.error("[deepagents/sveltekit] backend fetch failed", err);
      return new Response("upstream error", { status: 502 });
    }

    if (!backendResponse.body) {
      return new Response(null, { status: backendResponse.status });
    }

    // Build the passthrough response headers
    const responseHeaders = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });

    // Forward the AI SDK stream-version marker so useChat knows which protocol to use
    const aiSdkMarker = backendResponse.headers.get(
      "x-vercel-ai-ui-message-stream"
    );
    if (aiSdkMarker) {
      responseHeaders.set("x-vercel-ai-ui-message-stream", aiSdkMarker);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const accumulator = new SseFrameAccumulator();

    // Transform the SSE stream: buffer by frame boundary (\n\n) and apply
    // the transforms pipeline. We cannot regex-replace on raw bytes because
    // a chunk boundary can split a frame in the middle.
    const transformedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = backendResponse.body!.getReader();
        try {
          // eslint-disable-next-line no-constant-condition -- loop exits on done
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush any remaining buffer content. The accumulator already
              // bounded oversized incomplete trailing frames, but the final
              // flush may still hold a complete oversized frame — drop it
              // before passing to the transform pipeline.
              for (const frame of accumulator.flush()) {
                if (isFrameOversized(frame)) {
                  console.error(
                    `[deepagents/sveltekit] oversized frame (${frame.length} bytes), skipping`
                  );
                  continue;
                }
                const transformed = applyTransforms(allTransforms, {
                  raw: frame,
                });
                if (transformed !== null) {
                  controller.enqueue(
                    encoder.encode(ensureFrameTerminator(transformed.raw))
                  );
                }
              }
              controller.close();
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            for (const frame of accumulator.push(chunk)) {
              // Skip oversized frames so a pathological or malicious backend
              // can't blow up memory inside the transform pipeline.
              if (isFrameOversized(frame)) {
                console.error(
                  `[deepagents/sveltekit] oversized frame (${frame.length} bytes), skipping`
                );
                continue;
              }
              const transformed = applyTransforms(allTransforms, {
                raw: frame,
              });
              if (transformed !== null) {
                controller.enqueue(
                  encoder.encode(ensureFrameTerminator(transformed.raw))
                );
              }
            }
          }
        } catch (err) {
          console.error("[deepagents/sveltekit] mid-stream error", err);
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
