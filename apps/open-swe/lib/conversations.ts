"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_FRAMEWORK, isKnownFramework } from "./frameworks";

/**
 * The conversation registry — what "New chat" creates and what History lists.
 *
 * WHAT THIS STORES, AND WHAT IT DOES NOT. It stores conversation METADATA: an
 * id, a title, which framework the conversation is on, and when it was
 * touched. It does not store messages.
 *
 * That split is forced, not chosen. `useDeepAgentsChat` takes a `sessionId` and
 * forwards it as a body field; it has no `initialMessages` and nothing in the
 * chain persists a transcript. So selecting a past conversation restores its
 * SETTINGS — the session id the backend threads on, and the framework — and the
 * message list starts empty until the backend can replay a session. Claiming
 * otherwise in the UI would be a history that quietly loses your messages,
 * which is worse than a history that says what it is.
 *
 * Per-browser, like the workspace settings, and for the same reason: this app
 * has no store.
 */
export interface Conversation {
  id: string;
  title: string;
  framework: string;
  /** ISO 8601. Updated whenever the conversation is opened or renamed. */
  updatedAt: string;
  /** Optional per-conversation system prompt; overrides the workspace default. */
  systemPrompt?: string;
}

export const CONVERSATIONS_KEY = "open-swe:conversations:v1";

/**
 * New chats start on DeepAgents.
 *
 * Deliberately NOT `DEFAULT_FRAMEWORK` (the simplest rung). The ladder's order
 * answers "which is a step up from which"; the default for a new chat answers
 * "which will a person most likely want", and those are different questions
 * with different right answers. DeepAgents is the most capable rung and the
 * only one offering DeepResearch.
 */
export const NEW_CHAT_FRAMEWORK = "deepagents";

/** Guarded so a fork that ejects rung 3 still gets a framework that exists. */
export function defaultNewChatFramework(): string {
  return isKnownFramework(NEW_CHAT_FRAMEWORK)
    ? NEW_CHAT_FRAMEWORK
    : DEFAULT_FRAMEWORK;
}

/**
 * A title from the first thing the user said.
 *
 * Falls back to "New chat" rather than an empty string: a blank row in the
 * history list is indistinguishable from a rendering bug.
 */
export function titleFromMessage(text: string, max = 48): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function parseConversations(raw: string | null): Conversation[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (c): c is Conversation =>
          !!c &&
          typeof c === "object" &&
          typeof c.id === "string" &&
          c.id.length > 0
      )
      .map((c) => ({
        id: c.id,
        title: typeof c.title === "string" && c.title ? c.title : "New chat",
        framework: isKnownFramework(c.framework)
          ? c.framework
          : defaultNewChatFramework(),
        updatedAt:
          typeof c.updatedAt === "string"
            ? c.updatedAt
            : "1970-01-01T00:00:00Z",
        ...(typeof c.systemPrompt === "string"
          ? { systemPrompt: c.systemPrompt }
          : {}),
      }));
  } catch {
    return [];
  }
}

/** Most recently touched first. Ties keep input order so the list never jitters. */
export function sortConversations(
  list: readonly Conversation[]
): Conversation[] {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.updatedAt);
    const tb = Date.parse(b.updatedAt);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}

/**
 * Insert or update by id.
 *
 * Upsert rather than push: opening the same conversation twice must not create
 * a second row, and renaming must not create a duplicate under the new title.
 */
export function upsertConversation(
  list: readonly Conversation[],
  next: Conversation
): Conversation[] {
  const i = list.findIndex((c) => c.id === next.id);
  if (i === -1) return [next, ...list];
  const copy = [...list];
  copy[i] = { ...copy[i], ...next };
  return copy;
}

/**
 * Rename by id. Pure — the sidebar owns the affordance, this owns the rules.
 *
 * DUPLICATE TITLES ARE ALLOWED, deliberately (#151). The docstring above says
 * "renaming must not create a duplicate under the new title", and that is about
 * ROW identity — upsert by id so a rename edits the row instead of appending a
 * second one. It is not a uniqueness rule over titles, and it could not be:
 * every conversation this app creates starts as "New chat"
 * (AppSidebar.tsx), so duplicates exist before any rename happens. A rule
 * refusing them would enforce on the user an invariant the app violates by
 * default, and would forbid renaming anything back to "New chat".
 *
 * `id` is identity; `title` is a label. If that is ever revisited, the decision
 * lives in this one function.
 *
 * Returns a result rather than throwing or silently no-op'ing: the caller has
 * to decide what to show, and a rename that quietly does nothing is
 * indistinguishable from one that saved.
 */
export type RenameResult =
  | { ok: true; list: Conversation[] }
  | { ok: false; reason: "empty" | "not-found" };

export function renameConversation(
  list: readonly Conversation[],
  id: string,
  rawTitle: string,
  now: () => string = () => new Date().toISOString()
): RenameResult {
  const title = (rawTitle ?? "").replace(/\s+/g, " ").trim();
  // Never store a blank: a blank row is indistinguishable from a render bug,
  // which is the same reason titleFromMessage falls back to "New chat".
  if (!title) return { ok: false, reason: "empty" };

  const current = list.find((c) => c.id === id);
  if (!current) return { ok: false, reason: "not-found" };

  return {
    ok: true,
    // upsert by id — this is what "must not create a duplicate" means.
    list: upsertConversation(list, { ...current, title, updatedAt: now() }),
  };
}

export function removeConversation(
  list: readonly Conversation[],
  id: string
): Conversation[] {
  return list.filter((c) => c.id !== id);
}

/**
 * A fresh id.
 *
 * `crypto.randomUUID` where available, with a timestamp+random fallback so a
 * non-secure context still gets distinct ids rather than colliding on one.
 * Ids are conversation keys, not secrets.
 */
export function newConversationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Read/write the registry, shared by the sidebar and the chat surface.
 *
 * Seeded EMPTY and filled in an effect, not read during the first render:
 * this app prerenders, and touching localStorage while rendering makes the
 * server and client HTML disagree.
 *
 * `reload()` exists because two components use this hook against one store —
 * the sidebar lists conversations, the chat page upserts the one it is on —
 * and a plain `useState` in each would leave the sidebar showing a title the
 * chat page has already changed.
 */
/*
 * SAME-TAB FANOUT. The `storage` event DOES NOT FIRE IN THE TAB THAT WROTE —
 * that is the DOM spec, not a quirk: it notifies OTHER documents only.
 *
 * So two `useConversations()` in one page never learned about each other. The
 * sidebar's upsert updated its own state and localStorage while ShellCrumbs
 * kept a copy read at mount, forever. The visible symptom was #129 part 3: the
 * top bar never showed a conversation's title, and a rename reached the sidebar
 * and not the crumb — under a comment in ShellCrumbs that said the opposite,
 * "so a rename reaches the top bar on the same render that updates the sidebar".
 *
 * Cross-tab still goes through `storage`; this only adds the same-tab half that
 * the event deliberately omits.
 */
const localSubscribers = new Set<() => void>();

function notifySameTab(): void {
  for (const fn of [...localSubscribers]) fn();
}

/**
 * How many consumers are currently subscribed. EXPORTED FOR ONE TEST, and the
 * test is the reason it exists: "unmount removes the subscriber" is otherwise
 * unobservable, and the assertion degenerates into `expect(true).toBe(true)` —
 * a check that names a property and cannot fail, which is worse than no check.
 *
 * React 19 no longer warns on setState-after-unmount, so the leak this guards
 * would grow silently with every mount.
 */
export function __subscriberCountForTests(): number {
  return localSubscribers.size;
}

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);

  const read = useCallback((): Conversation[] => {
    try {
      return sortConversations(
        parseConversations(window.localStorage.getItem(CONVERSATIONS_KEY))
      );
    } catch {
      return []; // private windows and blocked site-data throw on access
    }
  }, []);

  useEffect(() => {
    setConversations(read());
    setLoaded(true);
    // Another tab writing the store should not leave this one stale.
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONVERSATIONS_KEY) setConversations(read());
    };
    window.addEventListener("storage", onStorage);
    // ...and the same-tab half, which `storage` does not cover.
    const onLocal = () => setConversations(read());
    localSubscribers.add(onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      localSubscribers.delete(onLocal);
    };
  }, [read]);

  const write = useCallback((next: Conversation[]) => {
    const sorted = sortConversations(next);
    setConversations(sorted);
    try {
      window.localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(sorted));
      notifySameTab();
      return true;
    } catch {
      return false; // surfaced by the caller; a silent failed save is a lie
    }
  }, []);

  const upsert = useCallback(
    (c: Conversation) => write(upsertConversation(read(), c)),
    [read, write]
  );

  const remove = useCallback(
    (id: string) => write(removeConversation(read(), id)),
    [read, write]
  );

  /**
   * Rename, returning whether it took. Reads fresh from the store first, like
   * upsert/remove, so a rename cannot clobber a change another tab just made.
   *
   * Returns the result rather than swallowing it: the sidebar needs to keep the
   * editor open on a rejected rename, and a rename that silently does nothing
   * looks exactly like one that saved.
   */
  const rename = useCallback(
    (id: string, title: string): RenameResult => {
      const result = renameConversation(read(), id, title);
      if (result.ok) write(result.list);
      return result;
    },
    [read, write]
  );

  return {
    conversations,
    loaded,
    upsert,
    remove,
    rename,
    reload: () => setConversations(read()),
  };
}
