// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useApprovalResponse,
  ApprovalResponseError,
} from "./useApprovalResponse";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useApprovalResponse — happy path", () => {
  it("POSTs { decision: 'approve' } to ${endpoint}/${approvalId} and resolves with parsed body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "ap-1", decision: "approve", accepted: true })
      );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    let resolved:
      | { id: string; decision: string; accepted: boolean }
      | undefined;
    await act(async () => {
      resolved = await result.current.respond("ap-1", "approve");
    });

    expect(resolved).toEqual({
      id: "ap-1",
      decision: "approve",
      accepted: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/approval/ap-1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ decision: "approve" });
    expect(result.current.status).toBe("success");
    expect(result.current.error).toBeNull();
  });

  it("transitions status through submitting → success", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    expect(result.current.status).toBe("idle");

    let promise: Promise<unknown> | undefined;
    act(() => {
      promise = result.current.respond("ap-2", "reject");
    });

    // Submitting state while fetch is in-flight.
    expect(result.current.status).toBe("submitting");

    await act(async () => {
      resolveFetch!(
        jsonResponse(200, { id: "ap-2", decision: "reject", accepted: true })
      );
      await promise;
    });

    expect(result.current.status).toBe("success");
  });

  it("posts a 'reject' decision when called with 'reject'", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "ap-3", decision: "reject", accepted: true })
      );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await result.current.respond("ap-3", "reject");
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ decision: "reject" });
  });

  it("URL-encodes the approvalId path segment", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "weird id/with space",
        decision: "approve",
        accepted: true,
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await result.current.respond("weird id/with space", "approve");
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/approval/weird%20id%2Fwith%20space");
  });

  it("strips a trailing slash from endpoint before joining the path", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "ap-4", decision: "approve", accepted: true })
      );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval/", fetchImpl })
    );

    await act(async () => {
      await result.current.respond("ap-4", "approve");
    });

    expect(fetchImpl.mock.calls[0][0]).toBe("/api/approval/ap-4");
  });
});

describe("useApprovalResponse — auth", () => {
  it("attaches Authorization: Bearer when getToken returns a string", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "ap-auth-1",
        decision: "approve",
        accepted: true,
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({
        endpoint: "/api/approval",
        getToken: () => "tok-abc",
        fetchImpl,
      })
    );

    await act(async () => {
      await result.current.respond("ap-auth-1", "approve");
    });

    const [, init] = fetchImpl.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
  });

  it("supports async getToken (returns a Promise<string>)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "ap-auth-2",
        decision: "approve",
        accepted: true,
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({
        endpoint: "/api/approval",
        getToken: async () => "tok-async",
        fetchImpl,
      })
    );

    await act(async () => {
      await result.current.respond("ap-auth-2", "approve");
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-async"
    );
  });

  it("omits Authorization header when getToken returns null/undefined/empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "ap-auth-3",
        decision: "approve",
        accepted: true,
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({
        endpoint: "/api/approval",
        getToken: () => null,
        fetchImpl,
      })
    );

    await act(async () => {
      await result.current.respond("ap-auth-3", "approve");
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect("Authorization" in (init?.headers as Record<string, string>)).toBe(
      false
    );
  });

  it("omits Authorization header when getToken is absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "ap-auth-4",
        decision: "approve",
        accepted: true,
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await result.current.respond("ap-auth-4", "approve");
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect("Authorization" in (init?.headers as Record<string, string>)).toBe(
      false
    );
  });
});

describe("useApprovalResponse — error paths", () => {
  it("rejects with ApprovalResponseError on non-2xx with status code preserved", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(409, {
        error: "approval already resolved",
        status: "approved",
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("ap-conflict-1", "approve")
      ).rejects.toBeInstanceOf(ApprovalResponseError);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(ApprovalResponseError);
    expect((result.current.error as ApprovalResponseError).statusCode).toBe(
      409
    );
    expect((result.current.error as ApprovalResponseError).message).toContain(
      "approval already resolved"
    );
  });

  it("rejects with a wrapped Error on network failure (fetch throws)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Network request failed"));

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("ap-net-1", "approve")
      ).rejects.toThrow("Network request failed");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toContain("Network request failed");
  });

  it("falls back to a generic message when the error body has no `error` field", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { something: "else" }));

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("ap-fallback-1", "approve")
      ).rejects.toThrow(/status 500/);
    });

    expect((result.current.error as ApprovalResponseError).statusCode).toBe(
      500
    );
  });

  it("handles a non-JSON error body gracefully (body field stays null)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not json at all", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("ap-nonjson-1", "approve")
      ).rejects.toBeInstanceOf(ApprovalResponseError);
    });

    const err = result.current.error as ApprovalResponseError;
    expect(err.statusCode).toBe(401);
    expect(err.body).toBeNull();
  });
});

describe("useApprovalResponse — edit decision", () => {
  it("respond('edit', { editedInput }) posts { decision, editedInput } and resolves", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "ap-edit-1", decision: "edit", accepted: true })
      );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.respond("ap-edit-1", "edit", {
        editedInput: { cmd: "ls" },
      });
    });

    expect(resolved).toEqual({
      id: "ap-edit-1",
      decision: "edit",
      accepted: true,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      decision: "edit",
      editedInput: { cmd: "ls" },
    });
    expect(result.current.status).toBe("success");
  });

  it("respond('edit') with missing payload throws synchronously (before fetch is called)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        // @ts-expect-error — intentionally violates the overload for runtime safety check
        result.current.respond("ap-edit-bad", "edit")
      ).rejects.toThrow(/editedInput/);
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
  });

  it("respond('edit') propagates a 400 from the server with status code preserved", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(400, {
        error: "decision 'edit' requires editedInput to be a JSON object",
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("ap-edit-400", "edit", {
          editedInput: { ok: true },
        })
      ).rejects.toBeInstanceOf(ApprovalResponseError);
    });

    expect((result.current.error as ApprovalResponseError).statusCode).toBe(
      400
    );
  });
});

describe("useApprovalResponse — respond decision", () => {
  it("respond('respond', { response }) posts { decision, response } and resolves", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "ap-respond-1",
        decision: "respond",
        accepted: true,
      })
    );

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await result.current.respond("ap-respond-1", "respond", {
        response: "try a dry run",
      });
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      decision: "respond",
      response: "try a dry run",
    });
    expect(result.current.status).toBe("success");
  });

  it("respond('respond') with missing payload throws synchronously (no fetch)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        // @ts-expect-error — intentionally violates the overload for runtime safety check
        result.current.respond("ap-respond-bad", "respond")
      ).rejects.toThrow(/response/);
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
  });

  it("respond('respond') with empty-string response throws synchronously (no fetch)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("ap-respond-empty", "respond", { response: "" })
      ).rejects.toThrow(/non-empty string/);
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("respond('respond') with non-string response throws synchronously", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        // @ts-expect-error — runtime safety check for non-string response
        result.current.respond("ap-respond-nonstr", "respond", {
          response: 123,
        })
      ).rejects.toThrow(/non-empty string/);
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("useApprovalResponse — reset()", () => {
  it("clears status and error back to idle/null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(404, { error: "approval not found" }));

    const { result } = renderHook(() =>
      useApprovalResponse({ endpoint: "/api/approval", fetchImpl })
    );

    await act(async () => {
      await expect(
        result.current.respond("missing", "approve")
      ).rejects.toThrow();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});

describe("useApprovalResponse — hook identity", () => {
  it("respond and reset keep stable identity across renders", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { result, rerender } = renderHook(
      ({ endpoint }) => useApprovalResponse({ endpoint, fetchImpl }),
      { initialProps: { endpoint: "/api/approval" } }
    );

    const respondV1 = result.current.respond;
    const resetV1 = result.current.reset;

    rerender({ endpoint: "/api/approval-v2" });

    expect(result.current.respond).toBe(respondV1);
    expect(result.current.reset).toBe(resetV1);
  });

  it("uses the latest endpoint from refs even when respond identity is stable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        id: "ap-stable-1",
        decision: "approve",
        accepted: true,
      })
    );
    const { result, rerender } = renderHook(
      ({ endpoint }) => useApprovalResponse({ endpoint, fetchImpl }),
      { initialProps: { endpoint: "/api/approval-old" } }
    );

    rerender({ endpoint: "/api/approval-new" });

    await act(async () => {
      await result.current.respond("ap-stable-1", "approve");
    });

    expect(fetchImpl.mock.calls[0][0]).toBe("/api/approval-new/ap-stable-1");
  });
});
