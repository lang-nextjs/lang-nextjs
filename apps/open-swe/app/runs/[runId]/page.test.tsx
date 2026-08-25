// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UseRunStreamResult } from "../../../lib/hooks/useRunStream";
import type { UseThreadStateResult } from "../../../lib/hooks/useThreadState";
import type { ToolCallState } from "../../../lib/types";

vi.mock("../../../lib/hooks/useRunStream", () => ({ useRunStream: vi.fn() }));
vi.mock("../../../lib/hooks/useToolState", () => ({ useToolState: vi.fn() }));
vi.mock("../../../lib/hooks/useThreadState", () => ({
  useThreadState: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ runId: "test-run-id" })),
  useSearchParams: vi.fn(() => new URLSearchParams("threadId=test-thread-id")),
}));

import { useRunStream } from "../../../lib/hooks/useRunStream";
import { useToolState } from "../../../lib/hooks/useToolState";
import { useThreadState } from "../../../lib/hooks/useThreadState";
import { useSearchParams } from "next/navigation";
import RunDetailPage from "./page";

const mockUseRunStream = useRunStream as ReturnType<typeof vi.fn>;
const mockUseToolState = useToolState as ReturnType<typeof vi.fn>;
const mockUseThreadState = useThreadState as ReturnType<typeof vi.fn>;
const mockUseSearchParams = useSearchParams as ReturnType<typeof vi.fn>;

const defaultStreamResult: UseRunStreamResult = {
  events: [],
  status: "connecting",
  error: null,
  retry: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
};

// Default: an ACTIVE run, so the page takes the live-stream path.
const liveThreadState: UseThreadStateResult = {
  items: [],
  status: "running",
  files: {},
  loading: false,
  error: null,
  refetch: vi.fn(),
};

beforeEach(() => {
  mockUseRunStream.mockReturnValue(defaultStreamResult);
  mockUseToolState.mockReturnValue([]);
  mockUseThreadState.mockReturnValue(liveThreadState);
  mockUseSearchParams.mockReturnValue(
    new URLSearchParams("threadId=test-thread-id")
  );
});

describe("RunDetail — live runs", () => {
  it("shows the live stream status while connecting", () => {
    mockUseRunStream.mockReturnValue({
      ...defaultStreamResult,
      status: "connecting",
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId("stream-status").textContent).toContain(
      "connecting"
    );
  });

  it("renders streamed text delta events as concatenated text", () => {
    mockUseRunStream.mockReturnValue({
      ...defaultStreamResult,
      status: "streaming",
      events: [
        { type: "text-delta", delta: "Hello, " },
        { type: "text-delta", delta: "world!" },
      ],
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId("agent-text").textContent).toBe("Hello, world!");
  });

  it("renders a ToolCard for each live tool call", () => {
    const toolCalls: ToolCallState[] = [
      { toolCallId: "tc-1", toolName: "bash", input: {}, status: "pending" },
      {
        toolCallId: "tc-2",
        toolName: "grep",
        input: {},
        status: "completed",
        output: {},
      },
    ];
    mockUseToolState.mockReturnValue(toolCalls);
    mockUseRunStream.mockReturnValue({
      ...defaultStreamResult,
      status: "streaming",
    });
    render(<RunDetailPage />);
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2);
  });
});

describe("RunDetail — completed runs (history)", () => {
  it("renders conversation history and does NOT stream or error", () => {
    mockUseThreadState.mockReturnValue({
      ...liveThreadState,
      status: "completed",
      items: [
        { id: "u1", kind: "user", text: "Do the thing" },
        {
          id: "t1",
          kind: "tool",
          toolName: "write_file",
          args: {},
          result: "ok",
          ok: true,
        },
        { id: "a1", kind: "assistant", text: "All done." },
      ],
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId("conversation-view")).toBeTruthy();
    expect(screen.getByTestId("conv-user").textContent).toContain(
      "Do the thing"
    );
    expect(screen.getByTestId("conv-assistant").textContent).toContain(
      "All done."
    );
    // No error shown for a completed run.
    expect(screen.queryByTestId("stream-error")).toBeNull();
  });

  it("shows a loading indicator while thread state loads", () => {
    mockUseThreadState.mockReturnValue({
      ...liveThreadState,
      status: null,
      loading: true,
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId("stream-status").textContent).toContain(
      "loading"
    );
  });
});

describe("RunDetail — errors", () => {
  it("shows an error with retry when thread state fails to load", () => {
    mockUseThreadState.mockReturnValue({
      ...liveThreadState,
      status: null,
      loading: false,
      error: new Error("Failed to load run (502)"),
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId("stream-error").textContent).toContain(
      "Failed to load run (502)"
    );
  });

  it("shows error state when threadId is missing from query string", () => {
    mockUseSearchParams.mockReturnValueOnce(new URLSearchParams(""));
    render(<RunDetailPage />);
    expect(screen.getByTestId("missing-thread-id")).toBeTruthy();
  });
});
