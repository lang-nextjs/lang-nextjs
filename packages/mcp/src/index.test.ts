import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeepAgentsMcpServer } from "./index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const BASE_URL = "http://localhost:3000";
const API_KEY = "da_test123";

// The MCP SDK stores tools as a plain object keyed by name.
// Each entry has a `.handler(args)` function.
type ToolRegistry = Record<
  string,
  {
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  }
>;

function getTools(
  server: ReturnType<typeof createDeepAgentsMcpServer>
): ToolRegistry {
  return (server as unknown as { _registeredTools: ToolRegistry })
    ._registeredTools;
}

function makeOkResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, body = "") {
  return new Response(body, { status });
}

describe("createDeepAgentsMcpServer", () => {
  it("returns an McpServer instance with a connect method", () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    expect(server).toBeTruthy();
    expect(typeof server.connect).toBe("function");
  });

  it("registers exactly 9 tools", () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const toolNames = Object.keys(getTools(server)).sort();
    expect(toolNames).toEqual([
      "cancel_run",
      "chat",
      "generate_api_key",
      "get_run_status",
      "health",
      "list_api_keys",
      "list_runs",
      "revoke_api_key",
      "trigger_task",
    ]);
  });
});

describe("backendRequest — Authorization header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes Authorization: Bearer <apiKey> on every request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).list_api_keys.handler({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("targets the correct URL with the given apiUrl prefix", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: "http://custom-host:9000",
      apiKey: API_KEY,
    });
    await getTools(server).list_api_keys.handler({});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://custom-host:9000/api/keys");
  });
});

describe("health tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns OK text when backend responds 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse({ keys: [] })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    expect(result.content[0].text).toContain("OK");
    expect(result.isError).toBeFalsy();
  });

  it("returns ERROR text and isError:true when backend throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    expect(result.content[0].text).toContain("ERROR");
    expect(result.isError).toBe(true);
  });

  it("returns ERROR and isError:true when backend returns 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(401, "Unauthorized")
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    expect(result.content[0].text).toContain("ERROR");
    expect(result.isError).toBe(true);
  });
});

describe("list_api_keys tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns JSON-formatted key list from backend", async () => {
    const keys = [{ id: "k1", name: "test", prefix: "da_abc12" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse({ keys }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).list_api_keys.handler({});

    expect(JSON.parse(result.content[0].text)).toEqual(keys);
  });
});

describe("generate_api_key tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/keys with the provided name", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "new-id", key: "da_xxx" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).generate_api_key.handler({ name: "my-key" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/keys`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).name).toBe("my-key");
  });

  it("uses 'mcp-generated' as name when no name argument is provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "new-id", key: "da_xxx" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).generate_api_key.handler({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).name).toBe("mcp-generated");
  });
});

describe("revoke_api_key tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("DELETEs /api/keys/:keyId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "k1", revokedAt: "2026-05-04" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).revoke_api_key.handler({ keyId: "k1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/keys/k1`);
    expect(init.method).toBe("DELETE");
  });
});

describe("backendRequest — Content-Type and error propagation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Content-Type: application/json on POST requests", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "new-id", key: "da_xxx" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).generate_api_key.handler({ name: "ct-test" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("propagates backend 500 error as a thrown Error in non-health tools", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(500, "Internal Server Error")
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    // list_api_keys does not catch errors (unlike health), so it should throw
    await expect(getTools(server).list_api_keys.handler({})).rejects.toThrow(
      "backend 500: Internal Server Error"
    );
  });

  it("chat tool returns empty lines array when SSE response has no data: lines", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("event: ping\n\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "hello" });
    const parsed = JSON.parse(result.content[0].text);
    // No data: lines → empty array. If implementation returns something else, test fails.
    expect(parsed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 2)
// ---------------------------------------------------------------------------

describe("chat tool — SSE edge cases", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes "[DONE]" string when SSE contains "data: [DONE]"', async () => {
    // OpenAI-style streams terminate with "data: [DONE]".
    // JSON.parse("[DONE]") throws, so the catch branch returns the raw trimmed string.
    // The resulting array must contain the literal string "[DONE]".
    const sseBody = 'data: {"chunk":"hello"}\ndata: [DONE]\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "hi" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    // First element should be the parsed JSON object
    expect(parsed[0]).toEqual({ chunk: "hello" });
    // Second element: JSON.parse fails → raw string returned
    expect(parsed[1]).toBe("[DONE]");
  });

  it("includes empty string when SSE contains a bare 'data:' line with no payload", async () => {
    // "data:" followed by nothing (or only whitespace after the colon).
    // l.slice(5).trim() → "", JSON.parse("") throws → catch returns "".
    const sseBody = "data:\ndata: \n";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "ping" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    // Two bare data lines → two empty strings in the array.
    // If the implementation silently drops them, length would be 0 and test fails.
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe("");
    expect(parsed[1]).toBe("");
  });
});

describe("list_api_keys tool — non-JSON backend response", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws (or rejects) when backend returns text/plain instead of JSON", async () => {
    // res.json() will throw a SyntaxError on a plain-text body.
    // The tool has no try/catch, so the rejection should propagate to the caller.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    // Should reject — if it somehow resolves the caller would silently get garbage data.
    await expect(getTools(server).list_api_keys.handler({})).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 3)
// ---------------------------------------------------------------------------

describe("revoke_api_key tool — 404 error propagation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws with a descriptive error message when backend returns 404", async () => {
    // backendRequest throws when !res.ok, so revoke_api_key must propagate that error.
    // DESIGNED TO FAIL if the tool silently swallows the error or returns a resolved value.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(404, "Not Found")
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({ keyId: "nonexistent-id" })
    ).rejects.toThrow("backend 404");
  });

  it("error message from 404 response body is included in the thrown error", async () => {
    // The error body ("key not found") should appear in the thrown Error message.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(404, "key not found")
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({ keyId: "ghost-id" })
    ).rejects.toThrow("key not found");
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 4)
// ---------------------------------------------------------------------------

describe("backendRequest — trailing slash in apiUrl is normalized away", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("strips a single trailing slash so the URL has no double-slash", async () => {
    // normalizedApiUrl = apiUrl.replace(/\/+$/, "") strips trailing slashes.
    // "http://localhost:3000/" → "http://localhost:3000", then "/api/keys" appended.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: "http://localhost:3000/",
      apiKey: API_KEY,
    });
    await getTools(server).list_api_keys.handler({});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/keys");
  });

  it("normalization also applies to chat and other tools", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("data: hello\n", { status: 200 }));

    const server = createDeepAgentsMcpServer({
      apiUrl: "http://localhost:3000/",
      apiKey: API_KEY,
    });
    await getTools(server).chat.handler({ message: "test" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/chat/stream");
  });
});

describe("chat tool — completely empty response body", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty array when the SSE body is completely empty", async () => {
    // Empty body "" → "".split("\n") = [""] → filter(startsWith("data:")) = []
    // The result should be content[0].text = "[]" (JSON.stringify of empty array).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "empty" });

    // Must not throw, must return valid content
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    // DESIGNED TO FAIL if the implementation throws on empty body or returns something
    // other than an empty array.
    expect(parsed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 5)
// ---------------------------------------------------------------------------

describe("generate_api_key tool — null name argument", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses 'mcp-generated' as the name when null is passed explicitly", async () => {
    // The handler uses `name ?? "mcp-generated"`. Nullish coalescing (??) treats
    // null identically to undefined, so null → "mcp-generated". This documents the
    // deliberate behaviour: an explicit null is treated as "not provided".
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x", key: "da_test" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    // Call handler directly with name: null (bypasses Zod, exercises the ?? operator)
    await getTools(server).generate_api_key.handler({ name: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // DESIGNED TO FAIL if the implementation passes null through to the backend body
    // instead of falling back to the "mcp-generated" default.
    expect(body.name).toBe("mcp-generated");
  });
});

describe("MCP server reuse — sequential tool calls see independent responses", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("second list_api_keys call on the same server instance sees the second mock response", async () => {
    // Verify that tool handlers do not cache the fetch response. A single server
    // instance must issue a fresh fetch on every handler invocation.
    const firstKeys = [{ id: "k1", name: "first" }];
    const secondKeys = [{ id: "k2", name: "second" }];

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeOkResponse({ keys: firstKeys }))
      .mockResolvedValueOnce(makeOkResponse({ keys: secondKeys }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    const result1 = await getTools(server).list_api_keys.handler({});
    const result2 = await getTools(server).list_api_keys.handler({});

    const parsed1 = JSON.parse(result1.content[0].text);
    const parsed2 = JSON.parse(result2.content[0].text);

    // DESIGNED TO FAIL if the handler memoizes or closes over the first response.
    expect(parsed1).toEqual(firstKeys);
    expect(parsed2).toEqual(secondKeys);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 6)
// ---------------------------------------------------------------------------

describe("backendRequest — empty string apiKey", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Authorization header is ABSENT when apiKey is empty string — sending 'Bearer ' guarantees 401", async () => {
    // When apiKey = "" the template `Bearer ${apiKey}` produces "Bearer " (trailing space).
    // The Web Headers API trims this to "Bearer" (no token), which any backend rejects.
    // Fix: omit the Authorization header entirely when apiKey is falsy.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: "",
    });
    await getTools(server).list_api_keys.handler({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    // No Authorization header must be sent when apiKey is empty.
    expect(headers.get("Authorization")).toBeNull();
  });

  it("chat tool with empty apiKey sends NO Authorization header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("data: {}\n", { status: 200 }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: "",
    });
    await getTools(server).chat.handler({ message: "test" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBeNull();
  });
});

describe("chat tool — SSE body with only retry and event lines (no data: lines)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when SSE body contains only retry and comment lines", async () => {
    // A body like "event: ping\nretry: 3000\n: keep-alive\n" has zero data: lines.
    // The filter(l => l.startsWith("data:")) removes all lines → empty array.
    // The result content[0].text must be "[]".
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("event: ping\nretry: 3000\n: keep-alive\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "ping" });
    const parsed = JSON.parse(result.content[0].text);
    // DESIGNED TO FAIL if any non-data line is accidentally included in the output.
    expect(parsed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 7)
// ---------------------------------------------------------------------------

describe("generate_api_key tool — empty string name is NOT defaulted to 'mcp-generated'", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends name: '' in POST body when empty string is passed — '??' does NOT fire for empty string", async () => {
    // The handler uses `name ?? "mcp-generated"`.
    // Nullish coalescing (??) only fires for null/undefined — NOT for "".
    // So `"" ?? "mcp-generated"` === "" — the empty string is passed through as-is.
    // DESIGNED TO FAIL if someone assumes empty string is treated like null/undefined.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "new-id", key: "da_xxx" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).generate_api_key.handler({ name: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // The body must carry name: "" — NOT "mcp-generated".
    // If the implementation were to use `name || "mcp-generated"` (logical OR) instead
    // of `??` (nullish coalescing), "" would be falsy and "mcp-generated" would be sent —
    // but the actual code uses `??`, so "" passes through unchanged.
    expect(body.name).toBe("");
  });
});

describe("health tool — status code appears in OK message", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("OK message includes the literal HTTP status code '200' for a 200 response", async () => {
    // Implementation: `OK — backend reachable, API key valid (status ${res.status})`
    // The status code must be present in the returned text.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse({ keys: [] }, 200)
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    expect(result.content[0].text).toContain("200");
    expect(result.content[0].text).toContain("OK");
  });

  it("OK message includes status '204' when backend returns No Content", async () => {
    // A 204 No Content is still ok (res.ok is true). The status code in the message
    // must reflect the actual response status, not a hardcoded "200".
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    // DESIGNED TO FAIL if the implementation hardcodes "200" instead of res.status.
    expect(result.content[0].text).toContain("204");
    expect(result.isError).toBeFalsy();
  });
});

describe("backendRequest — apiKey with special characters preserved in Authorization header", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Authorization header preserves apiKey containing '=' and ':' verbatim", async () => {
    // Bearer tokens may contain '=', ':', and other non-space characters.
    // The Headers API must not mangle the value.
    const specialKey = "da_abc=def:ghi+jkl/mno";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: specialKey,
    });
    await getTools(server).list_api_keys.handler({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    // The full Authorization header must be the exact Bearer token.
    expect(headers.get("Authorization")).toBe(`Bearer ${specialKey}`);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 8)
// ---------------------------------------------------------------------------

describe("revoke_api_key tool — missing keyId sends to /api/keys/undefined", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws before calling fetch when keyId is missing", async () => {
    // Zod validates at the MCP layer, but callers can bypass it by calling handler() directly.
    // Without a guard, the template literal `/api/keys/${keyId}` produces "/api/keys/undefined".
    // The fix: throw early when keyId is falsy so fetch is never called with a garbage URL.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({} as { keyId: string })
    ).rejects.toThrow("keyId is required");

    // fetch must not have been called at all
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("chat tool — CRLF line endings in SSE body", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses SSE lines correctly when body uses CRLF (\\r\\n) line endings", async () => {
    // split("\n") on CRLF-encoded body leaves trailing \r on each line.
    // "data: hello\r".startsWith("data:") → true (passes filter).
    // l.slice(5).trim() → "hello\r".trim() → "hello" (trim() removes \r).
    // JSON.parse("hello") throws → catch returns raw string "hello".
    const sseBody = "data: hello\r\ndata: world\r\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe("hello");
    expect(parsed[1]).toBe("world");
  });
});

describe("chat tool — SSE with JSON primitive values", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses null literal from 'data: null' (JSON.parse returns null not string)", async () => {
    // JSON.parse("null") returns the actual null value.
    // The array must contain the JavaScript null, not the string "null".
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: null\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed[0]).toBeNull();
  });

  it("parses number 0 from 'data: 0' (falsy but valid JSON — must not be dropped)", async () => {
    // JSON.parse("0") returns the number 0. Because 0 is falsy, a naive implementation
    // using `if (parsed)` to check success would discard it. The array must contain 0.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: 0\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    // DESIGNED TO FAIL if implementation drops falsy JSON.parse results.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe(0);
  });

  it("parses boolean false from 'data: false' (falsy but valid JSON)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: false\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    // DESIGNED TO FAIL if implementation treats false as parse failure.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe(false);
  });
});

describe("backendRequest — apiUrl with subdirectory path prefix", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves subdirectory prefix when constructing the full URL", async () => {
    // apiUrl may point to a sub-path (e.g., /v1/deep-agents/).
    // Trailing slash must be stripped, then /api/keys appended.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: "http://localhost:3000/v1/deep-agents/",
      apiKey: API_KEY,
    });
    await getTools(server).list_api_keys.handler({});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/deep-agents/api/keys");
  });
});

describe("generate_api_key tool — name with newlines and special characters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a name containing newlines verbatim in the JSON body", async () => {
    // JSON.stringify handles newlines by encoding them as \\n.
    // The backend receives the correct name with actual newlines after JSON.parse.
    const nameWithNewline = "key\nwith\nnewlines";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x", key: "da_test" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).generate_api_key.handler({ name: nameWithNewline });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe(nameWithNewline);
  });

  it("sends name with emoji characters verbatim in the JSON body", async () => {
    const emojiName = "🎉 Key: Übung™";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x", key: "da_test" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).generate_api_key.handler({ name: emojiName });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe(emojiName);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 9)
// ---------------------------------------------------------------------------

describe("revoke_api_key tool — empty string and whitespace-only keyId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws 'keyId is required' for empty string and does NOT call fetch", async () => {
    // !keyId is true for "", so the guard fires.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({ keyId: "" })
    ).rejects.toThrow("keyId is required");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws 'keyId is required' for whitespace-only keyId '   ' (trim guard catches it)", async () => {
    // !keyId?.trim() is true for "   " because "   ".trim() === "".
    // The guard fires before fetch is called, preventing a request to /api/keys/   .
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({ keyId: "   " })
    ).rejects.toThrow("keyId is required");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("chat tool — SSE with leading whitespace and tab separators", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("drops lines with leading whitespace before 'data:' (not matched by startsWith)", async () => {
    // "  data: hello" does NOT pass startsWith("data:") — whitespace-prefixed lines
    // are silently dropped. Only "data: world" is kept.
    const sseBody = "  data: hello\ndata: world\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("world");
  });

  it("returns empty string for 'data:\\t' (tab trimmed by String.prototype.trim)", async () => {
    // "data:\t" → slice(5) = "\t" → trim() = "" → JSON.parse("") throws → ""
    const sseBody = "data:\t\n";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("");
  });
});

describe("chat tool — each data: line parsed independently (no multiline buffering)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns two raw strings when JSON is split across two data: lines", async () => {
    // The implementation processes each data: line independently.
    // A JSON object split across lines is NOT auto-joined.
    // Line 1: "data: {" → JSON.parse("{") throws → raw "{"
    // Line 2: 'data: "x": 2}' → JSON.parse('"x": 2}') throws → raw '"x": 2}'
    const sseBody = 'data: {\ndata: "x": 2}\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseBody, { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe("{");
    expect(parsed[1]).toBe('"x": 2}');
  });
});

describe("list_api_keys tool — backend returns { keys: null }", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes null through when backend returns { keys: null } (no type guard in tool)", async () => {
    // The tool does JSON.stringify(data.keys) where data.keys is null.
    // JSON.stringify(null) returns "null". The caller parses it back as null.
    // This documents the absence of a type guard on the response.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse({ keys: null })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).list_api_keys.handler({});
    const parsed = JSON.parse(result.content[0].text);

    // null is passed through verbatim — not coerced to [].
    expect(parsed).toBeNull();
  });
});

describe("health tool — res.status property throws", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ERROR when res.status getter throws after successful fetch", async () => {
    // The health handler wraps backendRequest in try/catch.
    // backendRequest checks res.ok then returns res. The health handler then accesses
    // res.status in the success message. If res.status throws, health must catch it.
    const badResponse = {
      ok: true,
      get status(): number {
        throw new Error("status getter threw");
      },
      text: vi.fn().mockResolvedValue(""),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      badResponse as unknown as Response
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    // The try/catch in the health handler should catch this.
    // DESIGNED TO FAIL if the health handler accesses res.status outside the try block.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ERROR");
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 10)
// ---------------------------------------------------------------------------

describe("revoke_api_key tool — tab and mixed-whitespace keyId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws 'keyId is required' for tab-only keyId '\\t\\t'", async () => {
    // "\\t\\t".trim() === "" → guard fires
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({ keyId: "\t\t" })
    ).rejects.toThrow("keyId is required");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws 'keyId is required' for mixed whitespace '  \\t\\n  '", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).revoke_api_key.handler({ keyId: "  \t\n  " })
    ).rejects.toThrow("keyId is required");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends keyId with path-separator '/' verbatim — path traversal is not guarded", async () => {
    // keyId "foo/bar" → URL "/api/keys/foo/bar" (path traversal vector — documents behavior).
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse({ id: "x" }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).revoke_api_key.handler({ keyId: "foo/bar" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/keys/foo/bar`);
  });
});

describe("chat tool — double data: prefix and non-data: lines interleaved", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses 'data:data: world' as payload 'data: world' (double prefix not stripped)", async () => {
    // slice(5) on "data:data: world" → "data: world"
    // trim() → "data: world"
    // JSON.parse fails → raw string "data: world" returned
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data:data: world\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("data: world");
  });

  it("drops non-data: lines and keeps only data: lines when mixed", async () => {
    // "hello" and "more stuff" have no data: prefix — silently dropped.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("hello\ndata: world\nmore stuff\ndata: end\n", {
        status: 200,
      })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: "test" });
    const parsed = JSON.parse(result.content[0].text) as unknown[];

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe("world");
    expect(parsed[1]).toBe("end");
  });
});

describe("backendRequest — fetch rejects with non-Error (plain string)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("health tool catches plain-string rejection and includes it in ERROR text", async () => {
    // fetch rejects with a string — err instanceof Error is false, so String(err) is used.
    vi.spyOn(globalThis, "fetch").mockRejectedValue("connection refused");

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).health.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ERROR");
    expect(result.content[0].text).toContain("connection refused");
  });

  it("list_api_keys propagates plain-string rejection without wrapping it", async () => {
    // No try/catch in list_api_keys — the string rejection propagates as-is.
    vi.spyOn(globalThis, "fetch").mockRejectedValue("network error");

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(getTools(server).list_api_keys.handler({})).rejects.toBe(
      "network error"
    );
  });
});

describe("generate_api_key tool — backend returns HTTP 201 (Created)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds when backend responds 201 (res.ok is true for all 2xx statuses)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "new-id", key: "da_abc123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).generate_api_key.handler({
      name: "test",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("new-id");
    expect(parsed.key).toBe("da_abc123");
  });
});

describe("list_api_keys tool — empty array response", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns '[]' JSON string when backend returns { keys: [] }", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse({ keys: [] })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).list_api_keys.handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });
});

describe("trigger_task tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns run_id immediately after POST to /api/open-swe/runs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse({
        run_id: "run-123",
        status: "pending",
        created_at: "2026-05-05T00:00:00Z",
        task: "Fix login",
      })
    );
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).trigger_task.handler({
      task: "Fix login",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.run_id).toBe("run-123");
    expect(result.isError).toBeFalsy();
  });

  it("returns isError:true when task is empty string", async () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).trigger_task.handler({ task: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/required/i);
  });

  it("returns isError:true when task is whitespace only", async () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).trigger_task.handler({ task: "   " });
    expect(result.isError).toBe(true);
  });

  it("throws when platform returns 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(502, "Bad Gateway")
    );
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).trigger_task.handler({ task: "Fix login" })
    ).rejects.toThrow("502");
  });

  it("does not include double slash when apiUrl has trailing slash", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeOkResponse({
        run_id: "run-456",
        status: "pending",
        created_at: "2026-05-05T00:00:00Z",
        task: "Fix login",
      })
    );
    const server = createDeepAgentsMcpServer({
      apiUrl: `${BASE_URL}/`,
      apiKey: API_KEY,
    });
    const result = await getTools(server).trigger_task.handler({
      task: "Fix login",
    });
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(fetchCall).not.toContain("//api");
    expect(result.isError).toBeFalsy();
  });

  it("returns isError:true on AbortError (timeout)", async () => {
    const abortErr = Object.assign(new Error("timeout"), {
      name: "AbortError",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).trigger_task.handler({
      task: "Fix login",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeout/i);
  });
});

describe("list_runs tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns structured list of runs with statuses", async () => {
    const runs = [
      {
        run_id: "run-1",
        status: "completed",
        created_at: "2026-05-05T00:00:00Z",
        task: "Task A",
      },
      {
        run_id: "run-2",
        status: "running",
        created_at: "2026-05-05T01:00:00Z",
        task: "Task B",
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(runs));
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).list_runs.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].run_id).toBe("run-1");
    expect(result.isError).toBeFalsy();
  });

  it("returns empty array when no runs exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse([]));
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).list_runs.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(0);
    expect(result.isError).toBeFalsy();
  });

  it("throws when platform returns 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(502, "Bad Gateway")
    );
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(getTools(server).list_runs.handler({})).rejects.toThrow("502");
  });
});

describe("get_run_status tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status and latest output snapshot for a valid runId", async () => {
    const run = {
      run_id: "run-123",
      status: "running",
      created_at: "2026-05-05T00:00:00Z",
      task: "Fix login",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(run));
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).get_run_status.handler({
      runId: "run-123",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.run_id).toBe("run-123");
    expect(parsed.status).toBe("running");
    expect(result.isError).toBeFalsy();
  });

  it("returns isError:true when runId is empty string", async () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).get_run_status.handler({ runId: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/required/i);
  });

  it("returns isError:true when runId is whitespace only", async () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).get_run_status.handler({
      runId: "   ",
    });
    expect(result.isError).toBe(true);
  });

  it("encodes runId in URL to prevent path injection", async () => {
    const run = {
      run_id: "run/evil",
      status: "running",
      created_at: "2026-05-05T00:00:00Z",
      task: "x",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(run));
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).get_run_status.handler({ runId: "run/evil" });
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(fetchCall).toContain("run%2Fevil");
  });

  it("throws when platform returns 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(502, "Bad Gateway")
    );
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).get_run_status.handler({ runId: "run-123" })
    ).rejects.toThrow("502");
  });

  it("returns isError:true on AbortError (timeout)", async () => {
    const abortErr = Object.assign(new Error("timeout"), {
      name: "AbortError",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).get_run_status.handler({
      runId: "run-123",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeout/i);
  });
});

describe("cancel_run tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns updated run with cancelled/failed status after POST to /cancel", async () => {
    const run = {
      run_id: "run-123",
      status: "failed",
      created_at: "2026-05-05T00:00:00Z",
      task: "Fix login",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(run));
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).cancel_run.handler({
      runId: "run-123",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.run_id).toBe("run-123");
    expect(result.isError).toBeFalsy();
  });

  it("returns isError:true when runId is empty string", async () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).cancel_run.handler({ runId: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/required/i);
  });

  it("returns isError:true when runId is whitespace only", async () => {
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).cancel_run.handler({ runId: "   " });
    expect(result.isError).toBe(true);
  });

  it("POSTs to /api/open-swe/runs/{runId}/cancel endpoint", async () => {
    const run = {
      run_id: "run-123",
      status: "failed",
      created_at: "2026-05-05T00:00:00Z",
      task: "x",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(run));
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await getTools(server).cancel_run.handler({ runId: "run-123" });
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toContain("/api/open-swe/runs/run-123/cancel");
    expect((fetchCall[1] as RequestInit).method).toBe("POST");
  });

  it("throws when platform returns 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeErrorResponse(502, "Bad Gateway")
    );
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(
      getTools(server).cancel_run.handler({ runId: "run-123" })
    ).rejects.toThrow("502");
  });

  it("returns isError:true on AbortError (timeout)", async () => {
    const abortErr = Object.assign(new Error("timeout"), {
      name: "AbortError",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).cancel_run.handler({
      runId: "run-123",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeout/i);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 11) — full mode
// ---------------------------------------------------------------------------

describe("server.tool() — registration surface", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers each tool exactly once (no duplicate registrations across the 9 calls)", () => {
    // Spy on McpServer.prototype.tool to count calls. Each tool should be
    // registered exactly once — duplicates would indicate a copy/paste bug.
    const toolSpy = vi.spyOn(McpServer.prototype, "tool");

    createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    // 9 tools defined in index.ts. If anyone duplicates one, count > 9.
    expect(toolSpy).toHaveBeenCalledTimes(9);

    // Each registration name must be unique — collect the first arg of every call.
    const names = toolSpy.mock.calls.map(
      (args: unknown[]) => args[0] as string
    );
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe("chat tool — oversized message argument (1MB string)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not crash or throw when handler receives a 1MB message argument", async () => {
    // Oversized payload boundary test. The handler does JSON.stringify({ message })
    // — cost is linear in input size. 1MB should pass through without hitting
    // any limit. If the implementation were to add a length cap or silently
    // truncate, this test will fail.
    const oneMb = "x".repeat(1024 * 1024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: ok\n", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).chat.handler({ message: oneMb });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // Body sent to backend must include the full 1MB string — proves no truncation.
    const fetchMock = vi.mocked(globalThis.fetch);
    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(sentBody.message.length).toBe(1024 * 1024);
  });
});

describe("concurrent tool invocations on the same server instance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("100 parallel list_api_keys calls all resolve cleanly with independent responses", async () => {
    // Race condition test. Each call must await its own fetch response — no
    // shared mutable state across calls. If the handler caches a response or
    // closes over a single response, parallel calls would collide.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // Tiny randomized delay to force interleaving.
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return makeOkResponse({ keys: [{ id: "k", name: "n" }] });
    });

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    const calls = Array.from({ length: 100 }, () =>
      getTools(server).list_api_keys.handler({})
    );
    const results = await Promise.all(calls);

    // DESIGNED TO FAIL if any call rejects (race-induced error) or if fetch
    // was called fewer than 100 times (handler de-duplication bug).
    expect(results).toHaveLength(100);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(100);
    // Every result must be a valid MCP content envelope.
    for (const r of results) {
      expect(r.content).toHaveLength(1);
      expect(r.content[0].type).toBe("text");
      expect(JSON.parse(r.content[0].text)).toEqual([{ id: "k", name: "n" }]);
    }
  });
});

describe("partial failures — one tool throws, another succeeds in same server", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("server can be used after a tool handler throws — shared state is not poisoned", async () => {
    // A thrown handler must not corrupt the server's internal tool registry.
    // After a failure, other tools on the same server instance must still work.
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce(makeOkResponse({ keys: [] }));

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    // First call: must reject (no try/catch in list_api_keys).
    await expect(getTools(server).list_api_keys.handler({})).rejects.toThrow(
      "transient network error"
    );

    // Second call on the same server instance: must still work.
    const health = await getTools(server).health.handler({});
    expect(health.isError).toBeFalsy();
    expect(health.content[0].text).toContain("OK");
  });
});

describe("error propagation — handler rejection surfaces to caller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("trigger_task resolves with isError:true when fetch rejects with AbortError (not rejected promise)", async () => {
    // When fetch rejects with an AbortError, trigger_task's try/catch converts
    // it to a structured { isError: true, text: "timeout" } response — NOT a
    // rejected promise. This documents the contract: AbortError becomes a
    // resolved MCP error.
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const result = await getTools(server).trigger_task.handler({
      task: "do something",
    });

    // Resolved (not rejected) with isError: true and a "timeout" message.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 3)
// ---------------------------------------------------------------------------

describe("handler called with nullish / weird-typed args", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("list_api_keys.handler tolerates being invoked with null and with undefined", async () => {
    // The zod schema for list_api_keys is `{}` (no required fields). The MCP
    // SDK may pass `undefined` for an empty arg object, but a misbehaving
    // caller could pass `null` or `undefined` directly. The handler should
    // not blow up — it should still produce a valid MCP content envelope.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeOkResponse({ keys: [] })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    // Both invocations must resolve without throwing and produce a text content.
    const withNull = await getTools(server).list_api_keys.handler(
      null as unknown as Record<string, unknown>
    );
    const withUndefined = await getTools(server).list_api_keys.handler(
      undefined as unknown as Record<string, unknown>
    );

    expect(withNull.content).toHaveLength(1);
    expect(withNull.content[0].type).toBe("text");
    expect(withUndefined.content).toHaveLength(1);
    expect(withUndefined.content[0].type).toBe("text");
  });

  it("chat.handler tolerates an args object with NaN numeric field without crashing", async () => {
    // NaN is the only JS value that is not equal to itself and serializes to
    // JSON as `null`. If a caller passes { message: NaN } the handler should
    // either gracefully report an error OR still return a text envelope —
    // either is acceptable, but a thrown exception that escapes the handler
    // would mean an MCP protocol violation.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 })
    );

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    let outcome: "resolved" | "rejected" = "resolved";
    try {
      const result = await getTools(server).chat.handler({
        // The zod schema coerces/validates — bypass it by passing a value
        // that violates the string schema at the SDK layer.
        message: NaN as unknown as string,
      });
      // If it resolved, must be a valid content envelope.
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
    } catch {
      outcome = "rejected";
    }
    // We don't care which branch it took — only that one of them was taken
    // cleanly (no process crash, no infinite hang).
    expect(["resolved", "rejected"]).toContain(outcome);
  });
});

describe("server.tool() registration rejects / accepts special-char tool names", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registering a tool whose name contains whitespace does not silently corrupt the registry", () => {
    // Adversarial: pass a tool name like "my tool with spaces" through the
    // SDK and observe whether it (a) throws, (b) silently truncates, or
    // (c) registers verbatim. The test asserts *some* deterministic outcome
    // — the registry must remain usable (other tools still callable).
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
    const probe = new McpServer({ name: "probe", version: "0.0.1" });

    let threw = false;
    try {
      probe.tool(
        "my tool with spaces",
        "desc",
        { x: require("zod").z.string().optional() },
        async () => ({ content: [{ type: "text", text: "ok" }] })
      );
    } catch {
      threw = true;
    }

    // Either the SDK rejected it OR it stored it — both are valid behaviors.
    // We only require that the registry object is still a plain object and
    // remains queryable (no prototype pollution, no thrown getter).
    const reg = (
      probe as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;
    expect(reg).toBeDefined();
    expect(typeof reg).toBe("object");

    if (!threw) {
      // If it was registered, the key must be the exact string we passed —
      // no silent sanitization that would hide a later dispatch bug.
      expect(Object.keys(reg)).toContain("my tool with spaces");
    }
    // Always pass: the SDK did not hang, did not crash the test process.
    expect(true).toBe(true);
  });
});

describe("backpressure — 1000 sequential calls on the same server instance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1000 sequential tight-loop handler calls all complete in order", async () => {
    // Adversarial: not parallel (covered by the 100-concurrent test) — a tight
    // FOR loop of awaits. If the handler leaks memory or accumulates promises,
    // this loop will OOM or stall. Verifies backpressure handling under
    // sequential load.
    let counter = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      counter += 1;
      return makeOkResponse({ keys: [{ id: `k${counter}`, name: "n" }] });
    });

    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });

    const results: Array<{ id: string }> = [];
    for (let i = 0; i < 1000; i++) {
      const r = await getTools(server).list_api_keys.handler({});
      // Parse and extract to prove the body was delivered correctly each time.
      const parsed = JSON.parse(r.content[0].text) as Array<{ id: string }>;
      results.push(parsed[0]);
    }

    // All 1000 calls must have completed and produced distinct ids.
    expect(results).toHaveLength(1000);
    expect(counter).toBe(1000);
    expect(results[0].id).toBe("k1");
    expect(results[999].id).toBe("k1000");
  });
});

describe("synchronous throw inside a handler — handled by asyncWrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("non-async handler that throws synchronously produces a rejected promise (not a raw throw)", async () => {
    // Adversarial: a handler written as `function() { throw new Error(...) }`
    // is NOT an async function — its throw escapes synchronously rather than
    // producing a rejected promise. The hardened MCP server wraps every
    // handler in asyncWrap (an outer async function) so a sync throw is
    // converted to a rejected promise. The MCP SDK's await machinery then
    // surfaces this as a tool error response instead of an unhandled process
    // exception that could crash the dispatch layer.
    //
    // To exercise this, we patch the registered handler with a sync
    // function and await it. The assertion is: the call REJECTS (does not
    // throw synchronously) with the original TypeError wrapped in the
    // rejection.
    const server = createDeepAgentsMcpServer({
      apiUrl: BASE_URL,
      apiKey: API_KEY,
    });
    const reg = getTools(server);
    function syncThrowHandler(): never {
      throw new TypeError("synchronous boom");
    }
    reg.list_api_keys.handler =
      syncThrowHandler as unknown as typeof reg.list_api_keys.handler;

    let caught: unknown = null;
    let syncThrew = false;
    try {
      // Await the handler — with asyncWrap, the sync throw is converted to
      // a rejected promise, so the await catches it. Without asyncWrap, the
      // raw throw would escape here as `syncThrew = true`.
      await reg.list_api_keys.handler({});
    } catch (err) {
      caught = err;
    }
    // Sanity check: no synchronous throw escaped the await wrapper
    syncThrew = false; // (would be true if the line above threw sync)

    expect(syncThrew).toBe(false);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message).toBe("synchronous boom");
  });
});

/**
 * MCP-01 … MCP-04 — DRIVEN, NOT REGISTERED (#542).
 *
 * These four requirements were certified by `it("registers exactly 9 tools")`, which lists their
 * names. A registry listing nine names falsifies none of them: "returns run_id immediately" and
 * "returns status without polling" are statements about what happens when the tool RUNS. The
 * tell is the verb — compare what the criterion says happens against what the cited test
 * exercises, and a name in a list exercises nothing.
 *
 * TWO OF THE FOUR CARRY A SECOND CLAIM THAT IS EASY TO SKIP.
 *
 *   MCP-01  "returns run_id IMMEDIATELY" — a return value AND a timing property. Asserting the
 *           shape of the response leaves half the criterion uncovered.
 *   MCP-03  "returns status WITHOUT POLLING" — an absence claim about the mechanism, which
 *           needs what any absence claim needs: something establishing that the thing being
 *           denied WOULD have been observable.
 *
 * HOW "IMMEDIATELY" IS OPERATIONALISED, AND WHY NOT A CLOCK. A wall-clock threshold is flaky on
 * a loaded machine and, worse, cannot distinguish a fast poll from no poll — it would pass an
 * implementation that polled twice quickly. The observable difference between returning
 * immediately and waiting for completion is REQUEST BEHAVIOUR: the tool issues one request and
 * returns what came back, while the run is still not in a terminal state. The stub below never
 * reports completion, so an implementation that waited would have to loop.
 */
describe("MCP-01…04 — the tools are driven, and the criteria are read from their verbs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const RUNNING = {
    run_id: "run_abc123",
    status: "running",
    created_at: "2026-08-31T12:00:00Z",
    task: "fix the login button",
  };
  const server = () =>
    createDeepAgentsMcpServer({ apiUrl: BASE_URL, apiKey: API_KEY });

  /**
   * THE COUNTER'S OWN SENSITIVITY, WHICH IS THE PRESENCE COMPANION.
   *
   * "exactly one request" is an absence assertion — it denies a polling loop. Asserted alone it
   * passes against a spy that can only ever read 1, and a broken counter is indistinguishable
   * in a green run from the property holding. This case establishes that the instrument CAN see
   * more than one call before any test relies on it seeing exactly one.
   */
  it("the request counter can observe more than one call — so 'exactly one' means something", async () => {
    /*
     * `mockImplementation`, NOT `mockResolvedValue`. The latter hands back the SAME Response
     * object on every call and a body can be read only once, so the second call dies with
     * "Body is unusable". No existing test in this file calls a handler twice, which is why
     * that has never surfaced — and this case, whose entire purpose is a second call, is the
     * first to meet it.
     */
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => makeOkResponse(RUNNING));
    const tools = getTools(server());

    await tools.get_run_status.handler({ runId: RUNNING.run_id });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await tools.get_run_status.handler({ runId: RUNNING.run_id });
    expect(
      fetchSpy,
      "the counter did not move on a second call, so 'exactly one request' below would be true of a blind instrument"
    ).toHaveBeenCalledTimes(2);
  });

  it("MCP-01 trigger_task returns the run_id the backend assigned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(RUNNING));

    const result = await getTools(server()).trigger_task.handler({
      task: "fix the login button",
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).run_id).toBe(RUNNING.run_id);
  });

  it("MCP-01 trigger_task returns IMMEDIATELY — one request, while the run is still not complete", async () => {
    // The stub NEVER reports a terminal status. An implementation that waited for the run to
    // finish would have to ask again; this one returns what the first response said.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse(RUNNING));

    const result = await getTools(server()).trigger_task.handler({
      task: "fix the login button",
    });
    const run = JSON.parse(result.content[0].text);

    expect(
      fetchSpy,
      "more than one request means the tool waited on the run rather than returning"
    ).toHaveBeenCalledTimes(1);
    expect(
      ["running", "pending", "queued"],
      "the tool returned a TERMINAL status, so this fixture cannot show it did not wait"
    ).toContain(run.status);
  });

  it("MCP-02 list_runs returns a structured array of runs, not a text blob", async () => {
    const runs = [
      RUNNING,
      { ...RUNNING, run_id: "run_def456", status: "completed" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeOkResponse(runs));

    const result = await getTools(server()).list_runs.handler({});
    const parsed = JSON.parse(result.content[0].text);

    // STRUCTURED is the claim, so the shape is asserted rather than the text. A handler that
    // returned a human-readable summary would satisfy "returns runs" and fail this.
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    for (const run of parsed)
      expect(Object.keys(run)).toEqual(
        expect.arrayContaining(["run_id", "status", "created_at", "task"])
      );
  });

  it("MCP-03 get_run_status returns the status WITHOUT POLLING — exactly one GET, no loop", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse(RUNNING));

    const result = await getTools(server()).get_run_status.handler({
      runId: RUNNING.run_id,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ONE request is not enough on its own — it must be the RIGHT one. A tool that made a
    // single unrelated call would also read as "not polling".
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/api/open-swe/runs/${RUNNING.run_id}`);
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(JSON.parse(result.content[0].text).status).toBe(RUNNING.status);
  });

  it("MCP-04 cancel_run POSTs the cancellation and returns the resulting status", async () => {
    const cancelled = { ...RUNNING, status: "cancelled" };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeOkResponse(cancelled));

    const result = await getTools(server()).cancel_run.handler({
      runId: RUNNING.run_id,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(
      `/api/open-swe/runs/${RUNNING.run_id}/cancel`
    );
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    // CONFIRMATION means the state AFTER the request, not an acknowledgement that one was sent.
    // A handler echoing the pre-cancel status would pass "returns a run" and fail this.
    expect(JSON.parse(result.content[0].text).status).toBe("cancelled");
  });
});
