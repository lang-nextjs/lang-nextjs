"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  useWorkspaceSettings,
  type WorkspaceSettings,
} from "../../lib/workspace-settings";

/**
 * Provider display names.
 *
 * `blazing` is becoming Digital Frontier. The LABEL moves now and the type,
 * class and env var do not — renaming `SandboxProvider`, `BlazingSandbox` and
 * `BLAZING_API_URL` is a codebase-wide change with its own review, and doing it
 * halfway would leave a tree where the two names both mean the same thing and
 * neither is authoritative. The internal id is shown next to the label so this
 * page never hides which one is actually running.
 */
const PROVIDER_LABEL: Record<string, string> = {
  blazing: "Digital Frontier",
  docker: "Docker (local)",
};

const LLM_LABEL: Record<string, string> = {
  nvidia: "NVIDIA NIM",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
};

interface Config {
  activeLlm: string | null;
  llm?: Record<string, boolean>;
}

interface Health {
  provider?: string;
  available?: boolean;
  detail?: string;
}

export default function WorkspaceSettingsPage() {
  const { settings, save, loaded } = useWorkspaceSettings();
  const [draft, setDraft] = useState<WorkspaceSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<null | "ok" | "failed">(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);

  // The inputs are disabled until `loaded` (see below). That is the actual fix
  // for the race: seeding once is not enough when the SEED ITSELF can arrive
  // after the first keystroke, which is exactly what happens on a slow client.
  // An un-loaded form is not an empty form — it is a form whose contents are
  // not known yet, and letting someone type into it promises a save it cannot
  // keep.
  //
  // SEED ONCE. This effect exists to fill the form from storage after the
  // client-side read resolves. Re-running it later is not seeding — it is
  // discarding whatever the person has typed since.
  //
  // The load is async (hook reads localStorage in an effect), so on a slow
  // client it can land AFTER the first keystroke. Without this guard it then
  // resets `draft`, and the two visible symptoms are just how many fields were
  // filled after the reset: one field left -> dirty stays false and Save never
  // enables; a later field still edited -> Save enables and persists an object
  // missing the earlier edit. `save()` also calls setSettings, so the old
  // effect re-fired on every successful save too.
  const seeded = useRef(false);
  useEffect(() => {
    if (loaded && !seeded.current) {
      seeded.current = true;
      setDraft(settings);
    }
  }, [loaded, settings]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json() as Promise<Config>)
      .then((c) => {
        if (!cancelled) setCfg(c);
      })
      .catch(() => {
        // Presence of a key is advisory here; a failed probe must not blank
        // the page, so the panel stays in its "checking" state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/open-swe/sandbox/health")
      .then(async (r) => ({ ok: r.ok, body: (await r.json()) as Health }))
      .then(({ body }) => {
        if (!cancelled) setHealth(body);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setHealthError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    draft.systemPrompt !== settings.systemPrompt ||
    draft.folders.join("\n") !== settings.folders.join("\n");

  function onSave() {
    setSaved(save(draft) ? "ok" : "failed");
  }

  return (
    <div className="min-h-full">
      <div className="mx-auto w-full max-w-5xl p-4 lg:p-6">
        <div className="mb-6">
          <h1 className="text-foreground text-lg font-semibold tracking-tight">
            Workspace Settings
          </h1>
          <p className="text-muted-foreground mt-1 text-xs">
            Applied to every run started from this browser. Stored locally —
            this app has no settings service, so these do not follow you to
            another machine or reach anyone else.
          </p>
        </div>

        {/* ---------------- System prompt ---------------- */}
        <section className="border-border bg-card/40 mb-6 rounded-xl border p-4">
          <label
            htmlFor="system-prompt"
            className="text-foreground text-sm font-medium"
          >
            System prompt
          </label>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Prepended to the agent&apos;s own prompt. Leave empty to use the
            backend&apos;s default unchanged.
          </p>
          <textarea
            id="system-prompt"
            data-testid="settings-system-prompt"
            disabled={!loaded}
            value={draft.systemPrompt}
            onChange={(e) =>
              setDraft({ ...draft, systemPrompt: e.target.value })
            }
            rows={6}
            placeholder="You are a careful engineer working in this repository…"
            className="border-border text-foreground placeholder:text-muted-foreground focus:border-ring w-full resize-y rounded-lg border bg-transparent px-3 py-2 font-mono text-xs outline-none"
          />
        </section>

        {/* ---------------- Folders ---------------- */}
        <section className="border-border bg-card/40 mb-6 rounded-xl border p-4">
          <label
            htmlFor="folders"
            className="text-foreground text-sm font-medium"
          >
            Working folders
          </label>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            One path per line, relative to the workspace root. Blank lines are
            dropped.
          </p>
          <textarea
            id="folders"
            data-testid="settings-folders"
            disabled={!loaded}
            value={draft.folders.join("\n")}
            onChange={(e) =>
              setDraft({
                ...draft,
                folders: e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            rows={4}
            placeholder={"src/\ndocs/"}
            className="border-border text-foreground placeholder:text-muted-foreground focus:border-ring w-full resize-y rounded-lg border bg-transparent px-3 py-2 font-mono text-xs outline-none"
          />
          <p className="text-muted-foreground mt-2 text-[11px]">
            {draft.folders.length} folder
            {draft.folders.length === 1 ? "" : "s"}
          </p>
        </section>

        {/* ---------------- Sandbox (read-only) ---------------- */}
        <section className="border-border bg-card/40 mb-6 rounded-xl border p-4">
          <h2 className="text-foreground text-sm font-medium">Sandbox</h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Resolved on the server at boot and{" "}
            <strong className="text-foreground">not settable here</strong>. The
            workspace API keys records without a tenant component, so a browser
            able to name its own endpoint could be pointed at a shared instance
            and read across tenants. Change it through the environment.
          </p>

          <div
            data-testid="settings-sandbox"
            className="border-border flex items-center justify-between rounded-lg border px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  health?.available
                    ? "bg-success"
                    : health
                    ? "bg-destructive"
                    : "bg-muted-foreground"
                }`}
              />
              <span className="text-foreground text-sm">
                {health
                  ? PROVIDER_LABEL[health.provider ?? ""] ??
                    health.provider ??
                    "unknown"
                  : healthError
                  ? "unreachable"
                  : "checking…"}
              </span>
              {health?.provider && (
                <code className="text-muted-foreground text-[11px]">
                  ({health.provider})
                </code>
              )}
            </div>
            <span className="text-muted-foreground text-xs">
              {health?.detail ?? healthError ?? ""}
            </span>
          </div>
        </section>

        {/* ---------------- LLM key (read-only) ---------------- */}
        <section className="border-border bg-card/40 mb-6 rounded-xl border p-4">
          <h2 className="text-foreground text-sm font-medium">
            Model provider
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Read from the server environment and{" "}
            <strong className="text-foreground">not settable here</strong>. The
            agents are lazily-built singletons whose model is constructed once,
            so a key sent per request would either be ignored or force an agent
            rebuild on every message — a field for it would be a control that
            does nothing. Set <code>NVIDIA_API_KEY</code> in your{" "}
            <code>.env</code> (already gitignored) and restart the backend.
          </p>

          <div
            data-testid="settings-llm"
            className="border-border flex items-center justify-between rounded-lg border px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  cfg?.activeLlm
                    ? "bg-success"
                    : cfg
                    ? "bg-warning"
                    : "bg-muted-foreground"
                }`}
              />
              <span className="text-foreground text-sm">
                {cfg
                  ? LLM_LABEL[cfg.activeLlm ?? ""] ?? "No key configured"
                  : "checking…"}
              </span>
            </div>
            <span className="text-muted-foreground text-xs">
              {cfg?.activeLlm ? "configured" : cfg ? "runs will fail" : ""}
            </span>
          </div>

          {cfg && !cfg.activeLlm && (
            <p className="text-muted-foreground mt-3 text-xs">
              <strong className="text-foreground">
                NVIDIA NIM issues a free key with no card.
              </strong>{" "}
              Get one at{" "}
              <a
                href="https://build.nvidia.com"
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline"
              >
                build.nvidia.com
              </a>
              , then add <code>NVIDIA_API_KEY=…</code> to <code>.env</code>. It
              is tried first, ahead of OpenRouter and Anthropic.
            </p>
          )}
        </section>

        {/* ---------------- Save ---------------- */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty}
            data-testid="settings-save"
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setDraft(settings)}
            disabled={!dirty}
            className="border-border text-muted-foreground hover:text-foreground rounded-lg border px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
          >
            Revert
          </button>
          {saved === "ok" && !dirty && (
            <span className="text-success text-xs">Saved</span>
          )}
          {saved === "failed" && (
            // A save that silently did nothing is worse than one that failed
            // loudly — private windows and blocked site-data both throw here.
            <span className="text-destructive text-xs">
              Could not save — this browser is blocking local storage.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
