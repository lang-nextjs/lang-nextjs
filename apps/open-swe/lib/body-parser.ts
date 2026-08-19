export const MAX_BODY_BYTES = 1_048_576; // 1MB

export async function parseJsonBody(
  request: Request
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  // Check Content-Type header
  const contentType = request.headers.get("content-type");
  // Parse out the media type (strip parameters like ;charset=utf-8) and require
  // an EXACT match against application/json. A prefix match would incorrectly
  // accept unrelated MIME types like application/json-patch+json,
  // application/jsonml+xml, application/json-seq, etc.
  const mediaType = contentType?.toLowerCase().split(";")[0].trim();
  if (!mediaType || mediaType !== "application/json") {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Content-Type must be application/json" }),
        {
          status: 415,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }

  // Handle empty body (no request body)
  if (request.body === null || request.body === undefined) {
    return { ok: true, data: {} };
  }

  let totalBytes = 0;
  const decoder = new TextDecoder();

  try {
    // Read stream chunks and count bytes
    const reader = request.body?.getReader();
    if (!reader) {
      return { ok: true, data: {} };
    }

    let chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Check size limit before processing
      totalBytes += value.length;
      if (totalBytes > MAX_BODY_BYTES) {
        return {
          ok: false,
          response: new Response(
            JSON.stringify({ error: "Request body exceeds 1MB limit" }),
            {
              status: 413,
              headers: { "Content-Type": "application/json" },
            }
          ),
        };
      }

      chunks.push(value);
    }

    // If no chunks, return empty object
    if (chunks.length === 0) {
      return { ok: true, data: {} };
    }

    // Combine chunks and parse JSON
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const text = decoder.decode(combined);

    // A whitespace-only body carried real bytes that are not valid JSON.
    // Treat it as a 400 (malformed) rather than silently coercing to {} —
    // that would mask client bugs. (Genuinely empty bodies hit the
    // chunks.length === 0 early-return above and still resolve to {}.)
    if (text.trim() === "") {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ error: "Empty or whitespace-only body" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        ),
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }

    return { ok: true, data: parsed };
  } catch (error) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
}
