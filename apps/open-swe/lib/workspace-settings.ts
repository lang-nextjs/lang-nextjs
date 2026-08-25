"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Workspace settings — global to this app, not per-run.
 *
 * WHAT IS EDITABLE HERE AND WHAT IS NOT, because the split is a security
 * boundary rather than a design preference:
 *
 *   editable  systemPrompt, folders   — inputs to the agent
 *   NOT here  the sandbox endpoint    — server-owned, read-only in the UI
 *
 * The sandbox provider is resolved server-side from BLAZING_API_URL at boot
 * (lib/sandbox/index.ts). It is deliberately NOT settable from the browser: the
 * workspace API's Redis keys carry no tenant component, so a client that could
 * name its own endpoint could be pointed at a shared instance and read across
 * tenants. A settings page that offered a URL field would be handing that out.
 * So the page REPORTS which provider is live and leaves changing it to whoever
 * controls the environment.
 *
 * PERSISTENCE IS PER-BROWSER, and the page says so rather than implying more.
 * This app has no settings store — no Redis, no DB, no config service — so
 * localStorage is the honest ceiling. "Global" here means "app-wide instead of
 * per-run", not "shared between people". Pretending otherwise would be a claim
 * the storage cannot keep.
 */
export interface WorkspaceSettings {
  /** Prepended to the agent's own system prompt. Empty string = leave default. */
  systemPrompt: string;
  /** Paths the agent should treat as its working set, one per line. */
  folders: string[];
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  systemPrompt: "",
  folders: [],
};

/**
 * Exported so tests can seed the same key the hook reads, rather than
 * restating the literal. A test that writes its own copy of the key still
 * passes when the two drift, having verified nothing.
 */
export const SETTINGS_KEY = "open-swe:workspace-settings:v1";

/** Parse defensively: a hand-edited or half-written value must not brick the page. */
export function parseSettings(raw: string | null): WorkspaceSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const v = JSON.parse(raw) as Partial<WorkspaceSettings>;
    return {
      systemPrompt: typeof v.systemPrompt === "string" ? v.systemPrompt : "",
      folders: Array.isArray(v.folders)
        ? v.folders.filter((f): f is string => typeof f === "string")
        : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Which prompt a conversation actually sends.
 *
 * TWO LAYERS, AND THE OVERRIDE WINS WHOLE — it does not append to the
 * workspace default. Concatenating them would make the effective prompt depend
 * on a value the person editing the override cannot see from the chat panel,
 * and "why is the agent still doing X" would have an answer on another page.
 *
 * An override of "" is NOT an override. Empty means "not set", so clearing the
 * box falls back to the workspace default rather than silently suppressing it —
 * a text field cannot distinguish "I want no prompt" from "I have not typed
 * anything", and of the two readings, falling back is the recoverable one.
 */
export function effectiveSystemPrompt(
  workspaceDefault: string,
  conversationOverride?: string | null
): string {
  const override = (conversationOverride ?? "").trim();
  if (override) return override;
  return (workspaceDefault ?? "").trim();
}

export function useWorkspaceSettings() {
  // Seeded with the default rather than read at init: this is a client
  // component in an app that prerenders, and touching localStorage during the
  // first render makes server and client HTML disagree.
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      setSettings(parseSettings(window.localStorage.getItem(SETTINGS_KEY)));
    } catch {
      // Private windows and blocked site-data throw on access, not on read.
      setSettings(DEFAULT_SETTINGS);
    }
    setLoaded(true);
  }, []);

  const save = useCallback((next: WorkspaceSettings) => {
    setSettings(next);
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false; // caller surfaces this; a silent failed save is a lie
    }
  }, []);

  return { settings, save, loaded };
}
