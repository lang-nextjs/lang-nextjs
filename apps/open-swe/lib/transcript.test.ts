import { describe, it, expect } from "vitest";
import {
  parseStore,
  capEntries,
  capStore,
  appendEntry,
  MAX_ENTRIES_PER_CONVERSATION,
  MAX_TOTAL_BYTES,
  type Transcript,
  type TranscriptEntry,
} from "./transcript";

const entry = (
  text: string,
  role: "user" | "agent" = "user"
): TranscriptEntry => ({
  role,
  text,
  at: "2026-05-25T00:00:00Z",
});

const transcript = (n: number, evicted = false): Transcript => ({
  entries: Array.from({ length: n }, (_, i) => entry(`m${i}`)),
  evicted,
});

describe("parseStore — malformed must not read as empty (#140)", () => {
  it("returns an empty store for genuinely absent data", () => {
    expect(parseStore(null)).toEqual({});
  });

  it("THROWS on unparseable JSON rather than returning {}", () => {
    // The whole point. Returning {} here would render "no messages" over a
    // transcript that exists but could not be read — indistinguishable from a
    // conversation that genuinely had none.
    expect(() => parseStore("{not json")).toThrow();
  });

  it("THROWS when the store is not an object", () => {
    expect(() => parseStore("[]")).toThrow(/not an object/);
    expect(() => parseStore('"a string"')).toThrow(/not an object/);
  });

  it("THROWS when a conversation has no entries array", () => {
    expect(() => parseStore('{"c1":{"evicted":false}}')).toThrow(/entries/);
  });

  it("THROWS on a malformed entry rather than silently dropping it", () => {
    // A dropped entry is a shorter transcript that still looks complete.
    expect(() =>
      parseStore('{"c1":{"entries":[{"role":"wizard","text":"x","at":"t"}]}}')
    ).toThrow(/malformed/);
    expect(() =>
      parseStore('{"c1":{"entries":[{"role":"user","at":"t"}]}}')
    ).toThrow(/malformed/);
  });

  it("round-trips a well-formed store", () => {
    const raw = JSON.stringify({
      c1: { entries: [entry("hi")], evicted: false },
    });
    expect(parseStore(raw).c1.entries[0].text).toBe("hi");
  });

  it("treats a missing `evicted` as false rather than undefined", () => {
    const raw = JSON.stringify({ c1: { entries: [entry("hi")] } });
    expect(parseStore(raw).c1.evicted).toBe(false);
  });
});

describe("capEntries — eviction is recorded, not inferred", () => {
  it("leaves a transcript under the cap untouched and unmarked", () => {
    const t = capEntries(transcript(10));
    expect(t.entries).toHaveLength(10);
    expect(t.evicted).toBe(false);
  });

  it("keeps the NEWEST entries when over the cap", () => {
    const t = capEntries(transcript(MAX_ENTRIES_PER_CONVERSATION + 5));
    expect(t.entries).toHaveLength(MAX_ENTRIES_PER_CONVERSATION);
    // The last message must survive; dropping the newest would be absurd but
    // is exactly what an off-by-one slice direction produces.
    expect(t.entries[t.entries.length - 1].text).toBe(
      `m${MAX_ENTRIES_PER_CONVERSATION + 4}`
    );
    expect(t.entries[0].text).toBe("m5");
  });

  it("MARKS the transcript when it drops anything", () => {
    // Without this flag a truncated transcript begins mid-conversation and
    // looks complete — the defect this feature would otherwise introduce.
    expect(
      capEntries(transcript(MAX_ENTRIES_PER_CONVERSATION + 1)).evicted
    ).toBe(true);
  });

  it("does not un-mark a transcript that was evicted earlier", () => {
    expect(capEntries(transcript(5, true)).evicted).toBe(true);
  });
});

describe("capStore — the whole-store byte cap", () => {
  it("keeps everything when comfortably under the cap", () => {
    const store = { a: transcript(2), b: transcript(2) };
    const out = capStore(store, ["a", "b"]);
    expect(Object.keys(out).sort()).toEqual(["a", "b"]);
    expect(out.a.evicted).toBe(false);
  });

  it("drops the oldest conversations first and marks the survivors", () => {
    // Sized so two fit under MAX_TOTAL_BYTES and three do not — otherwise the
    // assertion below passes vacuously on a store that never needed evicting.
    // (First draft used 200k x3 = 600KB against a 1.5MB cap and evicted
    // nothing, which the `evicted` assertion correctly caught.)
    const big = (): Transcript => ({
      entries: [entry("x".repeat(600_000))],
      evicted: false,
    });
    const store = { newest: big(), middle: big(), oldest: big() };
    const out = capStore(store, ["newest", "middle", "oldest"]);

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(out.newest).toBeDefined();
    // Survivors are marked: from inside one conversation you cannot see that a
    // different one was evicted, so silence there would be a false claim of
    // completeness.
    for (const id of Object.keys(out)) expect(out[id].evicted).toBe(true);
  });

  it("evicts an ORPHANED transcript before any live conversation", () => {
    // A transcript whose conversation was deleted is the first thing that
    // should go, not the last — it is unreachable from the UI already.
    const big = (): Transcript => ({
      entries: [entry("x".repeat(800_000))],
      evicted: false,
    });
    const store = { live: big(), orphan: big() };
    const out = capStore(store, ["live"]); // orphan is not in the registry
    expect(out.live).toBeDefined();
    expect(out.orphan).toBeUndefined();
  });
});

describe("appendEntry", () => {
  it("starts a transcript for a conversation that has none", () => {
    const out = appendEntry({}, "c1", entry("first"));
    expect(out.c1.entries).toHaveLength(1);
    expect(out.c1.evicted).toBe(false);
  });

  it("appends in order and does not disturb other conversations", () => {
    const store = { c2: transcript(3) };
    const out = appendEntry(
      appendEntry(store, "c1", entry("a")),
      "c1",
      entry("b")
    );
    expect(out.c1.entries.map((e) => e.text)).toEqual(["a", "b"]);
    expect(out.c2.entries).toHaveLength(3);
  });

  it("applies the entry cap on append, so growth cannot outrun it", () => {
    let store: Record<string, Transcript> = {
      c1: transcript(MAX_ENTRIES_PER_CONVERSATION),
    };
    store = appendEntry(store, "c1", entry("newest"));
    expect(store.c1.entries).toHaveLength(MAX_ENTRIES_PER_CONVERSATION);
    expect(store.c1.entries[store.c1.entries.length - 1].text).toBe("newest");
    expect(store.c1.evicted).toBe(true);
  });
});
