import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  effectiveSystemPrompt,
  parseSettings,
} from "./workspace-settings";

describe("parseSettings — a bad value must not brick the page", () => {
  it("returns defaults for null (nothing stored yet)", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for unparseable JSON", () => {
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for JSON of the wrong shape", () => {
    expect(parseSettings("[1,2,3]")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"a string"')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a well-formed value", () => {
    const v = { systemPrompt: "Be terse.", folders: ["src/", "docs/"] };
    expect(parseSettings(JSON.stringify(v))).toEqual(v);
  });

  it("coerces a non-string systemPrompt to empty rather than rendering it", () => {
    // A number in the textarea's value would throw in React; defaulting is the
    // recoverable reading of a hand-edited store.
    expect(parseSettings('{"systemPrompt": 42}').systemPrompt).toBe("");
    expect(parseSettings('{"systemPrompt": null}').systemPrompt).toBe("");
  });

  it("drops non-string folder entries instead of failing the whole parse", () => {
    // Partial recovery: one bad entry should not cost the user their prompt.
    const v = parseSettings(
      '{"systemPrompt":"keep me","folders":["a",7,null,"b"]}'
    );
    expect(v.folders).toEqual(["a", "b"]);
    expect(v.systemPrompt).toBe("keep me");
  });

  it("treats a non-array folders field as empty", () => {
    expect(parseSettings('{"folders": "src/"}').folders).toEqual([]);
  });

  it("ignores unknown keys rather than passing them through", () => {
    const v = parseSettings('{"systemPrompt":"x","folders":[],"evil":"y"}');
    expect(Object.keys(v).sort()).toEqual(["folders", "systemPrompt"]);
  });
});

describe("effectiveSystemPrompt — the override wins whole", () => {
  it("uses the workspace default when there is no override", () => {
    expect(effectiveSystemPrompt("workspace", undefined)).toBe("workspace");
    expect(effectiveSystemPrompt("workspace", null)).toBe("workspace");
  });

  it("replaces the default entirely — it does not append", () => {
    const out = effectiveSystemPrompt("workspace", "conversation");
    expect(out).toBe("conversation");
    expect(out).not.toContain("workspace");
  });

  it("treats an empty or whitespace override as 'not set', not 'no prompt'", () => {
    // Clearing the box falls back rather than silently suppressing the default:
    // a text field cannot distinguish "I want none" from "I typed nothing".
    expect(effectiveSystemPrompt("workspace", "")).toBe("workspace");
    expect(effectiveSystemPrompt("workspace", "   \n ")).toBe("workspace");
  });

  it("returns empty when neither is set — the backend keeps its own prompt", () => {
    expect(effectiveSystemPrompt("", "")).toBe("");
    expect(effectiveSystemPrompt("", null)).toBe("");
  });

  it("trims, so a stray newline never becomes a system message", () => {
    expect(effectiveSystemPrompt("  spaced  ", null)).toBe("spaced");
    expect(effectiveSystemPrompt("", "  over  ")).toBe("over");
  });
});
