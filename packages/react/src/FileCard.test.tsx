// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FileCard } from "./FileCard";
import type { DataFile } from "./schemas";

afterEach(() => {
  cleanup();
});

function makeFile(overrides: Partial<DataFile> = {}): DataFile {
  return {
    id: "file-1",
    seq: 0,
    path: "/work/notes.md",
    name: "notes.md",
    language: "markdown",
    size: 1234,
    truncated: false,
    content: "# Notes\n\nHello.",
    updatedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  };
}

describe("FileCard — rendering", () => {
  it("renders name, path, formatted size, language, and updatedAt", () => {
    render(<FileCard file={makeFile()} />);
    expect(screen.getByTestId("file-name").textContent).toBe("notes.md");
    expect(screen.getByTestId("file-path").textContent).toBe("/work/notes.md");
    expect(screen.getByTestId("file-size").textContent).toBe("1.2 KB");
    expect(screen.getByTestId("file-language").textContent).toBe("markdown");
    expect(screen.getByTestId("file-updated-at").getAttribute("dateTime")).toBe(
      "2026-04-29T00:00:00Z"
    );
  });

  it("formats bytes < 1024 in bytes", () => {
    render(<FileCard file={makeFile({ size: 512 })} />);
    expect(screen.getByTestId("file-size").textContent).toBe("512 B");
  });

  it("formats bytes >= 1 MB in MB", () => {
    render(<FileCard file={makeFile({ size: 2 * 1024 * 1024 })} />);
    expect(screen.getByTestId("file-size").textContent).toBe("2.00 MB");
  });

  it("exposes id, seq, and truncated as data-* attributes", () => {
    render(
      <FileCard file={makeFile({ id: "file-z", seq: 7, truncated: true })} />
    );
    const card = screen.getByTestId("file-card");
    expect(card.getAttribute("data-file-id")).toBe("file-z");
    expect(card.getAttribute("data-file-seq")).toBe("7");
    expect(card.getAttribute("data-file-truncated")).toBe("true");
  });

  it("renders the truncated flag indicator when truncated", () => {
    render(<FileCard file={makeFile({ truncated: true })} />);
    expect(screen.getByTestId("file-truncated-flag")).toBeTruthy();
  });

  it("does not render the truncated flag when not truncated", () => {
    render(<FileCard file={makeFile({ truncated: false })} />);
    expect(screen.queryByTestId("file-truncated-flag")).toBeNull();
  });

  it("does not render language span when language is null", () => {
    render(<FileCard file={makeFile({ language: null })} />);
    expect(screen.queryByTestId("file-language")).toBeNull();
  });
});

describe("FileCard — expand/collapse", () => {
  it("by default content is hidden; clicking the expand button shows it", () => {
    render(<FileCard file={makeFile()} />);
    expect(screen.queryByTestId("file-content")).toBeNull();
    expect(screen.getByTestId("file-expand-button").textContent).toContain(
      "Show"
    );
    fireEvent.click(screen.getByTestId("file-expand-button"));
    expect(screen.getByTestId("file-content").textContent).toContain("# Notes");
    expect(screen.getByTestId("file-expand-button").textContent).toContain(
      "Hide"
    );
  });

  it("expand button reflects aria-expanded state", () => {
    render(<FileCard file={makeFile()} />);
    const btn = screen.getByTestId("file-expand-button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("expand button is NOT rendered when content is empty/null", () => {
    render(<FileCard file={makeFile({ content: null })} />);
    expect(screen.queryByTestId("file-expand-button")).toBeNull();
  });

  it("expand button is NOT rendered when allowExpand={false}", () => {
    render(<FileCard file={makeFile()} allowExpand={false} />);
    expect(screen.queryByTestId("file-expand-button")).toBeNull();
    expect(screen.queryByTestId("file-content")).toBeNull();
  });
});

describe("FileCard — accessibility & passthrough", () => {
  it("outer article has aria-label derived from path", () => {
    render(<FileCard file={makeFile({ path: "/etc/hosts" })} />);
    expect(
      screen.getByTestId("file-card").getAttribute("aria-label")
    ).toContain("/etc/hosts");
  });

  it("forwards className to the outer article", () => {
    render(<FileCard file={makeFile()} className="my-file" />);
    expect(screen.getByTestId("file-card").className).toContain("my-file");
  });

  it("truncated-flag indicator carries role=note for assistive tech", () => {
    render(<FileCard file={makeFile({ truncated: true })} />);
    expect(screen.getByTestId("file-truncated-flag").getAttribute("role")).toBe(
      "note"
    );
  });
});
