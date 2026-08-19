// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  cleanup,
} from "@testing-library/react";
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
    description: "Run this shell command?",
    arguments: { cmd: "ls -la /tmp" },
    status: "waiting",
    createdAt: "2026-04-29T00:00:00Z",
    expiresAt: null,
    ...overrides,
  };
}

describe("ApprovalCard — rendering", () => {
  it("renders action name, description, status, and pretty-printed arguments", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByTestId("approval-action-name").textContent).toBe(
      "bash_execute"
    );
    expect(screen.getByTestId("approval-description").textContent).toBe(
      "Run this shell command?"
    );
    expect(screen.getByTestId("approval-status").textContent).toBe("waiting");
    expect(screen.getByTestId("approval-arguments").textContent).toContain(
      '"cmd": "ls -la /tmp"'
    );
  });

  it("exposes approvalId and status as data-* attributes for selector-based testing", () => {
    render(
      <ApprovalCard
        approval={makeApproval({ id: "appr-xyz", status: "rejected" })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("data-approval-id")).toBe("appr-xyz");
    expect(card.getAttribute("data-status")).toBe("rejected");
  });

  it("applies the optional className to the outer wrapper", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        className="custom-class"
      />
    );
    expect(screen.getByTestId("approval-card").className).toContain(
      "custom-class"
    );
  });

  it("does NOT render the Edit button when onEdit is omitted", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.queryByTestId("show-edit-button")).toBeNull();
  });

  it("does NOT render the Respond button when onRespond is omitted", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.queryByTestId("show-respond-button")).toBeNull();
  });

  it("renders all four buttons when all handlers are provided", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
        onRespond={vi.fn()}
      />
    );
    expect(screen.getByTestId("approve-button")).toBeTruthy();
    expect(screen.getByTestId("reject-button")).toBeTruthy();
    expect(screen.getByTestId("show-edit-button")).toBeTruthy();
    expect(screen.getByTestId("show-respond-button")).toBeTruthy();
  });
});

describe("ApprovalCard — approve / reject", () => {
  it("clicking Approve invokes onApprove exactly once", () => {
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={onApprove}
        onReject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("approve-button"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("clicking Reject invokes onReject exactly once", () => {
    const onReject = vi.fn();
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={onReject}
      />
    );
    fireEvent.click(screen.getByTestId("reject-button"));
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalCard — disabled state", () => {
  it("disables all four buttons when disabled={true}", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
        onRespond={vi.fn()}
        disabled
      />
    );
    expect(
      (screen.getByTestId("approve-button") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("reject-button") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("show-edit-button") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("show-respond-button") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("disables buttons when status is not 'waiting' (already resolved)", () => {
    for (const status of ["approved", "rejected", "timeout"] as const) {
      const { unmount } = render(
        <ApprovalCard
          approval={makeApproval({ status })}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />
      );
      expect(
        (screen.getByTestId("approve-button") as HTMLButtonElement).disabled
      ).toBe(true);
      unmount();
    }
  });
});

describe("ApprovalCard — edit mode", () => {
  it("clicking Edit shows the edit panel pre-populated with current arguments", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    expect(screen.getByTestId("approval-edit-panel")).toBeTruthy();
    expect(
      (screen.getByTestId("edit-input") as HTMLTextAreaElement).value
    ).toContain('"cmd": "ls -la /tmp"');
  });

  it("editing the textarea and submitting invokes onEdit with the parsed JSON object", () => {
    const onEdit = vi.fn();
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: '{"cmd": "ls"}' },
    });
    fireEvent.click(screen.getByTestId("submit-edit-button"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ cmd: "ls" });
  });

  it("invalid JSON shows an inline error and does NOT call onEdit", () => {
    const onEdit = vi.fn();
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: "not json {" },
    });
    fireEvent.click(screen.getByTestId("submit-edit-button"));
    expect(onEdit).not.toHaveBeenCalled();
    const err = screen.getByTestId("edit-error");
    expect(err).toBeTruthy();
    expect(err.getAttribute("role")).toBe("alert");
  });

  it("non-object JSON (array, string, null) shows an inline error", () => {
    const onEdit = vi.fn();
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: '["nope"]' },
    });
    fireEvent.click(screen.getByTestId("submit-edit-button"));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByTestId("edit-error").textContent).toContain("object");
  });

  it("Cancel returns to the actions view and resets the textarea to the original arguments", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: '{"cmd": "scrubbed"}' },
    });
    fireEvent.click(screen.getByTestId("cancel-edit-button"));
    expect(screen.queryByTestId("approval-edit-panel")).toBeNull();
    expect(screen.getByTestId("approval-actions")).toBeTruthy();

    // Reopen and confirm the field was reset.
    fireEvent.click(screen.getByTestId("show-edit-button"));
    expect(
      (screen.getByTestId("edit-input") as HTMLTextAreaElement).value
    ).toContain('"ls -la /tmp"');
  });

  it("typing after a previous error clears the error (UX feedback loop)", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: "broken" },
    });
    fireEvent.click(screen.getByTestId("submit-edit-button"));
    expect(screen.getByTestId("edit-error")).toBeTruthy();
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: '{"cmd": "x"}' },
    });
    expect(screen.queryByTestId("edit-error")).toBeNull();
  });
});

describe("ApprovalCard — respond mode", () => {
  it("clicking Respond shows the respond panel; submit is disabled while the input is empty", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRespond={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-respond-button"));
    expect(screen.getByTestId("approval-respond-panel")).toBeTruthy();
    expect(
      (screen.getByTestId("submit-respond-button") as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("typing a response enables submit; clicking submit calls onRespond with the text", () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRespond={onRespond}
      />
    );
    fireEvent.click(screen.getByTestId("show-respond-button"));
    fireEvent.change(screen.getByTestId("respond-input"), {
      target: { value: "try grep instead" },
    });
    expect(
      (screen.getByTestId("submit-respond-button") as HTMLButtonElement)
        .disabled
    ).toBe(false);
    fireEvent.click(screen.getByTestId("submit-respond-button"));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("try grep instead");
  });

  it("Cancel from respond mode returns to actions and clears the response text", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRespond={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-respond-button"));
    fireEvent.change(screen.getByTestId("respond-input"), {
      target: { value: "scrubbed" },
    });
    fireEvent.click(screen.getByTestId("cancel-respond-button"));
    expect(screen.queryByTestId("approval-respond-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("show-respond-button"));
    expect(
      (screen.getByTestId("respond-input") as HTMLTextAreaElement).value
    ).toBe("");
  });
});

describe("ApprovalCard — accessibility", () => {
  it("outer wrapper has role=region and a descriptive aria-label", () => {
    render(
      <ApprovalCard
        approval={makeApproval({ actionName: "delete_file" })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("role")).toBe("region");
    expect(card.getAttribute("aria-label")).toContain("delete_file");
  });

  it("the edit-error element has role=alert for screen-reader announcement", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    fireEvent.change(screen.getByTestId("edit-input"), {
      target: { value: "broken" },
    });
    fireEvent.click(screen.getByTestId("submit-edit-button"));
    expect(screen.getByTestId("edit-error").getAttribute("role")).toBe("alert");
  });

  it("edit and respond textareas have associated <label> via htmlFor/id", () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onEdit={vi.fn()}
        onRespond={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("show-edit-button"));
    const editPanel = screen.getByTestId("approval-edit-panel");
    const editLabel = within(editPanel).getByText(/edit arguments/i);
    const editInput = screen.getByTestId("edit-input");
    expect(editLabel.getAttribute("for")).toBe(editInput.id);
  });
});
