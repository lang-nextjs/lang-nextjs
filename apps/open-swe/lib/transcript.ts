"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Client-side transcript persistence for the conversation registry (#122).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. This stores a RECORD of what was on screen.
 * It is not resumed context. The backend's memory of a session comes from
 * `sessionId` and may be empty, expired, or served by a different process, so
 * the transcript here and the context the agent actually has CAN DIVERGE. A
 * user looking at their own history will reasonably assume the agent remembers
 * it, which is why the UI renders this as a labelled record rather than as
 * ordinary messages — see ChatTranscriptRecord.
 *
 * That is this repo's recurring shape one more time: the thing displayed and
 * the thing being evaluated come from different places. Here they come from
 * different STORES.
 *
 * WHY CLIENT-SIDE AND NOT SESSION REPLAY (ruled in #122): replay would have to
 * be built per framework and per runtime — LangGraph has checkpointers, the
 * langchain ReAct path does not, deepagents differs again — which makes history
 * a capability that exists at some rungs and not others. A rung-1 fork would
 * silently lose it. This happens ABOVE the framework, so it is uniform across
 * all five rungs and nothing in Python has to support anything.
 *
 * THE FAILURE MODE THIS FILE IS ORGANISED AROUND. A transcript that silently
 * truncates is worse than no transcript: it looks complete. So eviction is
 * recorded in the data (`evicted`) rather than inferred, a failed write is
 * returned rather than swallowed, and a read distinguishes "there were no
 * messages" from "we could not read them" — the same three-state discipline as
 * `tracing` on /health and `llmConfigured` on /chat.
 */

export const TRANSCRIPT_KEY = "open-swe:transcripts:v1";

/**
 * Caps. Deliberately well under localStorage's ~5MB so that the quota error is
 * the exceptional path rather than the expected one — if we routinely relied on
 * catching QuotaExceededError we would be using an exception as a control flow
 * for the common case, and every browser disagrees about when it throws.
 */
export const MAX_ENTRIES_PER_CONVERSATION = 200;
export const MAX_TOTAL_BYTES = 1_500_000;

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  /** ISO 8601. */
  at: string;
}

export interface Transcript {
  entries: TranscriptEntry[];
  /**
   * True when older entries were dropped to stay within a cap. Stored, not
   * derived: once the older entries are gone there is nothing left to infer it
   * from, and a transcript that quietly begins mid-conversation is the exact
   * defect this feature would otherwise introduce.
   */
  evicted: boolean;
}

/** Three states, because "none" and "unreadable" are different facts. */
export type TranscriptRead =
  | { state: "ok"; transcript: Transcript }
  | { state: "empty" }
  | { state: "unreadable"; reason: string };

/** A write either persisted (possibly after evicting) or did not. */
export type TranscriptWrite =
  | { ok: true; evicted: boolean }
  | { ok: false; reason: "quota" | "blocked"; message: string };

type Store = Record<string, Transcript>;

// ---------------------------------------------------------------------------
// Pure core — no DOM, so the caps and the eviction rules are unit-testable
// without a browser.
// ---------------------------------------------------------------------------

function isEntry(v: unknown): v is TranscriptEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    (e.role === "user" || e.role === "agent") &&
    typeof e.text === "string" &&
    typeof e.at === "string"
  );
}

/**
 * Parse the whole store. THROWS on malformed input rather than returning an
 * empty store, because a caller that cannot tell those apart will render
 * "no messages" over a transcript that exists but could not be read (#140).
 */
export function parseStore(raw: string | null): Store {
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw); // may throw — deliberately
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("transcript store is not an object");
  }
  const out: Store = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`transcript for "${id}" is not an object`);
    }
    const t = value as Record<string, unknown>;
    if (!Array.isArray(t.entries)) {
      throw new Error(`transcript for "${id}" has no entries array`);
    }
    if (!t.entries.every(isEntry)) {
      throw new Error(`transcript for "${id}" has a malformed entry`);
    }
    out[id] = {
      entries: t.entries as TranscriptEntry[],
      evicted: t.evicted === true,
    };
  }
  return out;
}

/** Apply the per-conversation entry cap, recording whether anything was lost. */
export function capEntries(t: Transcript): Transcript {
  if (t.entries.length <= MAX_ENTRIES_PER_CONVERSATION) return t;
  return {
    entries: t.entries.slice(-MAX_ENTRIES_PER_CONVERSATION),
    evicted: true,
  };
}

/**
 * Apply the whole-store byte cap by dropping the OLDEST-touched conversations
 * first, and mark the survivors so the loss is never silent.
 *
 * `order` is the conversation ids most-recent-first (the registry already sorts
 * that way). Anything not named in `order` is treated as older than everything
 * that is — an orphaned transcript whose conversation was deleted should be the
 * first thing to go, not the last.
 */
export function capStore(store: Store, order: string[]): Store {
  const rank = new Map(order.map((id, i) => [id, i]));
  const ids = Object.keys(store).sort(
    (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)
  );
  const kept: Store = {};
  let dropped = false;
  for (const id of ids) {
    const candidate = { ...kept, [id]: store[id] };
    if (JSON.stringify(candidate).length > MAX_TOTAL_BYTES) {
      dropped = true;
      continue;
    }
    kept[id] = store[id];
  }
  if (dropped) {
    // Every surviving conversation is marked, because from inside one
    // conversation you cannot tell that a different one was evicted — and the
    // honest claim at that point is "history was trimmed", not silence.
    for (const id of Object.keys(kept)) {
      kept[id] = { ...kept[id], evicted: true };
    }
  }
  return kept;
}

/** Append an entry to a conversation's transcript, applying the entry cap. */
export function appendEntry(
  store: Store,
  conversationId: string,
  entry: TranscriptEntry
): Store {
  const existing = store[conversationId] ?? { entries: [], evicted: false };
  return {
    ...store,
    [conversationId]: capEntries({
      entries: [...existing.entries, entry],
      evicted: existing.evicted,
    }),
  };
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export function useTranscript(conversationId: string | null) {
  const [read, setRead] = useState<TranscriptRead>({ state: "empty" });
  const [loaded, setLoaded] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback((): TranscriptRead => {
    if (!conversationId) return { state: "empty" };
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(TRANSCRIPT_KEY);
    } catch (err) {
      // A browser blocking site data is not an empty history.
      return {
        state: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      const store = parseStore(raw);
      const t = store[conversationId];
      if (!t || t.entries.length === 0) return { state: "empty" };
      return { state: "ok", transcript: t };
    } catch (err) {
      return {
        state: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }, [conversationId]);

  useEffect(() => {
    setRead(load());
    setLoaded(true);
  }, [load]);

  /**
   * Persist one entry. Returns the outcome; callers MUST surface a failure.
   * A save that silently did nothing is the lie this whole file exists to
   * avoid, and it is exactly what a private window produces.
   */
  const append = useCallback(
    (entry: TranscriptEntry, order: string[]): TranscriptWrite => {
      if (!conversationId) return { ok: true, evicted: false };
      let store: Store;
      try {
        store = parseStore(window.localStorage.getItem(TRANSCRIPT_KEY));
      } catch {
        // Unreadable existing store: start a fresh one rather than refusing to
        // record anything ever again. The reader still reports "unreadable"
        // until this write lands, so nothing claims to have data it lacks.
        store = {};
      }
      const next = capStore(appendEntry(store, conversationId, entry), order);
      try {
        window.localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(next));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setWriteError(message);
        return {
          ok: false,
          reason: /quota/i.test(message) ? "quota" : "blocked",
          message,
        };
      }
      setWriteError(null);
      const saved = next[conversationId];
      setRead(
        saved && saved.entries.length > 0
          ? { state: "ok", transcript: saved }
          : { state: "empty" }
      );
      return { ok: true, evicted: saved?.evicted === true };
    },
    [conversationId]
  );

  return { read, loaded, append, writeError };
}
