// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { UseRunStreamResult } from "../../../lib/hooks/useRunStream";
import type { UseThreadStateResult } from "../../../lib/hooks/useThreadState";
import type { ToolCallState } from "../../../lib/types";

vi.mock("../../../lib/hooks/useRunStream", () => ({ useRunStream: vi.fn() }));
vi.mock("../../../lib/hooks/useToolState", () => ({ useToolState: vi.fn() }));
vi.mock("../../../lib/hooks/useThreadState", () => ({
  useThreadState: vi.fn(),
}));
vi.mock("../../../lib/hooks/useBackendTopology", () => ({
  useBackendTopology: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ runId: "test-run-id" })),
  useSearchParams: vi.fn(() => new URLSearchParams("threadId=test-thread-id")),
}));

import { useRunStream } from "../../../lib/hooks/useRunStream";
import { useToolState } from "../../../lib/hooks/useToolState";
import { useThreadState } from "../../../lib/hooks/useThreadState";
import { useBackendTopology } from "../../../lib/hooks/useBackendTopology";
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
  cancelError: null,
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

/**
 * THE THREAD-STATE FACT IS STATED ONCE, AND LABELLED (#709).
 *
 * It used to be rendered three times — a `StatusBadge` pill, a `STATUS` row in
 * `RunFacts`, and (in a different sense) the provenance banner — none of them
 * saying which question it was answering. The duplicate row is what these
 * assertions pin.
 *
 * WHY THE PRESENCE COMPANION. "run-fact-status is absent" passes identically
 * against a `RunFacts` that renders NOTHING — a component broken into silence
 * satisfies every absence assertion ever written about it. So the companion
 * asserts the strip is still there and still carrying the identifiers it exists
 * to carry; only the duplicated fact left.
 */
describe("RunDetail — status is stated once (#709)", () => {
  it("drops the duplicated STATUS row while keeping the identifier strip", () => {
    mockUseThreadState.mockReturnValue({
      ...liveThreadState,
      status: "completed",
      items: [{ id: "u1", kind: "user", text: "Do the thing" }],
    });
    render(<RunDetailPage />);

    // The duplicate is gone...
    expect(screen.queryByTestId("run-fact-status")).toBeNull();

    // ...and the panel it lived in is demonstrably still rendering. Without
    // this, the assertion above cannot tell a removed row from a dead panel.
    expect(screen.getByTestId("run-facts")).toBeTruthy();
    expect(screen.getByTestId("run-fact-run")).toBeTruthy();
    expect(screen.getByTestId("run-fact-thread")).toBeTruthy();
  });

  it("labels the thread fact, so it cannot be read as a verdict on the run", () => {
    mockUseThreadState.mockReturnValue({
      ...liveThreadState,
      status: "idle",
      items: [{ id: "u1", kind: "user", text: "Do the thing" }],
    });
    render(<RunDetailPage />);
    // Keyed to the status line itself, not to a landmark role: AppShell
    // already owns the page's `banner`, and this component deliberately does
    // not add a second one.
    const line = screen.getByTestId("run-status-line");
    expect(line.textContent).toContain("Thread");
    expect(line.textContent).toContain("Idle (thread)");
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

/**
 * THE NOTICE IS ACTUALLY MOUNTED (#423).
 *
 * RunTopologyNotice has its own test proving it renders differently for the two
 * backends. That test passes just as well if NOTHING RENDERS THE COMPONENT —
 * which is not a hypothetical failure in this repo: a triangulation check was
 * found counting a component no page mounted, and reported coverage for a
 * surface no user could reach. A component test is a claim about a component; it
 * is not a claim about the page.
 *
 * So these drive the PAGE, through the same hook the page really calls, and
 * assert on what a user of the run view would see.
 */
describe("run page — does this view say whether it is the whole agent", () => {
  beforeEach(() => {
    vi.mocked(useThreadState).mockReturnValue({
      items: [],
      status: "idle",
      loading: false,
      error: null,
      refetch: vi.fn(),
      provenance: undefined,
    } as unknown as UseThreadStateResult);
    vi.mocked(useRunStream).mockReturnValue({
      events: [],
      status: "idle",
      error: null,
      cancelError: null,
      cancel: vi.fn(),
    } as unknown as UseRunStreamResult);
    vi.mocked(useToolState).mockReturnValue([] as ToolCallState[]);
  });

  it("mounts the multi-graph notice on the PAGE, not just in its own test", () => {
    vi.mocked(useBackendTopology).mockReturnValue({
      known: true,
      graphs: ["manager", "planner", "programmer"],
      multiGraph: true,
    });
    render(<RunDetailPage />);
    expect(screen.getByTestId("run-topology").textContent).toContain("1 of 3");
  });

  it("leaves the page unchanged against the single-run backend that ships", () => {
    vi.mocked(useBackendTopology).mockReturnValue({
      known: true,
      graphs: ["agent"],
      multiGraph: false,
    });
    render(<RunDetailPage />);
    expect(screen.queryByTestId("run-topology")).toBeNull();
  });

  /*
   * The page-level discriminator. Both assertions above hold on a page that
   * ignores the hook — the first if it always renders the notice, the second if
   * it never does. Only the difference between two renders of the SAME page
   * shows that the page reads the probe.
   */
  it("renders the run view DIFFERENTLY for the two backends", () => {
    vi.mocked(useBackendTopology).mockReturnValue({
      known: true,
      graphs: ["agent"],
      multiGraph: false,
    });
    const single = render(<RunDetailPage />).container.innerHTML;
    cleanup();
    vi.mocked(useBackendTopology).mockReturnValue({
      known: true,
      graphs: ["manager", "planner", "programmer"],
      multiGraph: true,
    });
    const multi = render(<RunDetailPage />).container.innerHTML;
    expect(single).not.toBe(multi);
  });

  it("says so on the page when the probe could not answer", () => {
    vi.mocked(useBackendTopology).mockReturnValue({
      known: false,
      reason: "backend unreachable",
    });
    render(<RunDetailPage />);
    expect(
      screen.getByTestId("run-topology").getAttribute("data-topology")
    ).toBe("unknown");
  });
});
