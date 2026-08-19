// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  renderHook,
  act,
} from "@testing-library/react";
import { useApprovalCardController } from "./useApprovalCardController";
import { ApprovalCard } from "./ApprovalCard";
import type { DataApproval } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeApproval(overrides: Partial<DataApproval> = {}): DataApproval {
  return {
    id: "appr-1",
    seq: 0,
    actionName: "bash_execute",
    description: "Run this?",
    arguments: { cmd: "ls" },
    status: "waiting",
    createdAt: "2026-04-29T00:00:00Z",
    expiresAt: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useApprovalCardController — cardPropsFor", () => {
  it("returns all four wired handlers when used with ApprovalCard", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "appr-1", decision: "approve", accepted: true })
      );

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return <ApprovalCard {...cardPropsFor(makeApproval())} />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId("approve-button"));

    // Microtask flush so the fetch resolves before we assert.
    await act(async () => {});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/approval/appr-1");
    expect(JSON.parse(init?.body as string)).toEqual({ decision: "approve" });
  });

  it("Reject button POSTs decision='reject'", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "appr-1", decision: "reject", accepted: true })
      );

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return <ApprovalCard {...cardPropsFor(makeApproval())} />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId("reject-button"));
    await act(async () => {});

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ decision: "reject" });
  });

  it("Edit flow submits decision='edit' with editedInput from the textarea", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "appr-1", decision: "edit", accepted: true })
      );

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return <ApprovalCard {...cardPropsFor(makeApproval())} />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: '{"cmd": "ls -la"}' },
    });
    fireEvent.click(screen.getByTestId("submit-edit-button"));
    await act(async () => {});

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      decision: "edit",
      editedInput: { cmd: "ls -la" },
    });
  });

  it("Respond flow submits decision='respond' with the entered response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { id: "appr-1", decision: "respond", accepted: true })
      );

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return <ApprovalCard {...cardPropsFor(makeApproval())} />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId("show-respond-button"));
    fireEvent.change(screen.getByTestId("respond-input"), {
      target: { value: "try grep" },
    });
    fireEvent.click(screen.getByTestId("submit-respond-button"));
    await act(async () => {});

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      decision: "respond",
      response: "try grep",
    });
  });
});

describe("useApprovalCardController — disabled while submitting", () => {
  it("ApprovalCard buttons are disabled when status === 'submitting'", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return <ApprovalCard {...cardPropsFor(makeApproval())} />;
    }

    render(<Harness />);
    expect(
      (screen.getByTestId("approve-button") as HTMLButtonElement).disabled
    ).toBe(false);

    fireEvent.click(screen.getByTestId("approve-button"));

    // Re-render happens synchronously when status flips to "submitting".
    expect(
      (screen.getByTestId("approve-button") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("reject-button") as HTMLButtonElement).disabled
    ).toBe(true);

    // Resolve the request — buttons re-enable... well, actually the approval
    // status doesn't auto-flip to "approved" on the card (that comes from the
    // SSE side). The controller's `disabled` only reflects in-flight state.
    await act(async () => {
      resolveFetch!(
        jsonResponse(200, { id: "appr-1", decision: "approve", accepted: true })
      );
    });

    expect(
      (screen.getByTestId("approve-button") as HTMLButtonElement).disabled
    ).toBe(false);
  });
});

describe("useApprovalCardController — overrides", () => {
  it("override handler takes precedence over the default wired handler", async () => {
    const customApprove = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return (
        <ApprovalCard
          {...cardPropsFor(makeApproval(), { onApprove: customApprove })}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByTestId("approve-button"));
    await act(async () => {});

    expect(customApprove).toHaveBeenCalledTimes(1);
    // Default handler did not fire because override replaced it.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("overrides can disable a mode by replacing it with undefined to hide its button", () => {
    const fetchImpl = vi.fn<typeof fetch>();

    function Harness() {
      const { cardPropsFor } = useApprovalCardController({
        endpoint: "/api/approval",
        fetchImpl,
      });
      return (
        <ApprovalCard
          {...cardPropsFor(makeApproval(), {
            onEdit: undefined,
            onRespond: undefined,
          })}
        />
      );
    }

    render(<Harness />);
    expect(screen.queryByTestId("show-edit-button")).toBeNull();
    expect(screen.queryByTestId("show-respond-button")).toBeNull();
  });
});

describe("useApprovalCardController — error surface", () => {
  it("non-2xx responses surface in `error` and `status` of the hook return", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(409, { error: "approval already resolved" })
      );

    const { result } = renderHook(() =>
      useApprovalCardController({ endpoint: "/api/approval", fetchImpl })
    );

    const props = result.current.cardPropsFor(makeApproval());
    await act(async () => {
      await expect(props.onApprove()).rejects.toBeDefined();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).not.toBeNull();
  });
});
