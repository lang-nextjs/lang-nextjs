"use client";

import { ExternalLink } from "lucide-react";

import { useEffect, useState } from "react";
import {
  describeDependency,
  formatAge,
  type DependencyReport,
  type DependencyProbe,
  readDependencyProbe,
} from "../../lib/dependency-status";
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
  // #126: live dependency probes. Distinct from `cfg` above, which is a
  // CONFIGURATION read — the proxy this panel used to render as health.
  // THREE STATES, NOT TWO (#237). `DependencyReport[] | null` had no word for
  // "the probe failed", so a 500 was filed under `[]` — no rows, no message,
  // identical to a successful probe that found nothing.
  const [probe, setProbe] = useState<DependencyProbe>({ kind: "probing" });
  const deps = probe.kind === "ok" ? probe.rows : null;
  const depsAt = probe.kind === "ok" ? probe.probedAt : undefined;
  const [verifying, setVerifying] = useState(false);

  async function loadDeps(verify = false, refresh = false): Promise<void> {
    if (verify) setVerifying(true);
    setProbe({ kind: "probing" });
    try {
      const r = await fetch(
        `/api/open-swe/dependencies${verify ? "?verify=llm" : ""}${
          verify && refresh ? "&refresh=1" : ""
        }`,
        { cache: "no-store" }
      );
      // `r.ok` is READ now. It was not, so a 500 carrying {"error": …} fell
      // through `b.dependencies ?? []` and rendered as a clean empty panel —
      // the one thing this panel exists to report was the thing it could not.
      setProbe(await readDependencyProbe(r));
    } catch (err) {
      // A failed load must not leave stale rows looking current, and must not
      // look like a probe that succeeded and found nothing either.
      setProbe({
        kind: "failed",
        message:
          err instanceof Error ? err.message : "the probe could not be reached",
      });
    } finally {
      setVerifying(false);
    }
  }
  // VERIFY ON LOAD, WITHOUT BEING ASKED.
  //
  // This was `loadDeps(false)`, so Inference rendered "configured, not
  // verified" until someone pressed a button. Requested directly: "i want it
  // to consume that call ... dont want to have to click on Verify inference".
  //
  // Two things had to change together. Passing `true` here alone would have
  // auto-run a check that fetched the backend's /health and reported
  // `responding` for a KEY BEING PRESENT — a cost warning attached to
  // something that could not fail for the reason it named. The probe is now a
  // real prompt whose tokens are watched, and the route caches the verdict for
  // five minutes so a refresh does not spend a second call.
  useEffect(() => {
    void loadDeps(true);
  }, []);

  // The inputs are disabled until SEEDED — not until `loaded`. The difference
  // is one render, and that render was the bug: `loaded` flips inside the
  // hook's effect, React paints with the inputs now ENABLED and `draft` still
  // DEFAULT_SETTINGS, and only then does the seeding effect below run. Anyone
  // typing into that window has their text discarded by the seed that follows.
  //
  // Seeding once is not enough when the SEED ITSELF can arrive after the first
  // keystroke, which is exactly what happens on a slow client.
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
  // STATE, NOT A REF, because the inputs gate on it. A ref records that seeding
  // happened without re-rendering, so the inputs would still be enabled by the
  // render that `loaded` triggered — which is the window this closes.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (loaded && !seeded) {
      setSeeded(true);
      setDraft(settings);
    }
  }, [loaded, seeded, settings]);

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
            disabled={!seeded}
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
            disabled={!seeded}
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
        {/*
         * DEPENDENCY STATUS — #126.
         *
         * Every row is a live observation or is explicitly marked as not one.
         * The tone mapping is exhaustive via assertNever in describeDependency,
         * so a sixth state is a compile error rather than a fall-through to
         * grey. Nothing here renders healthy on the strength of a config read.
         */}
        <section className="border-border rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-foreground text-sm font-medium">Dependencies</h2>
            <span
              data-testid="deps-age"
              className="text-muted-foreground text-xs"
            >
              {formatAge(depsAt, Date.now())}
            </span>
          </div>

          <ul data-testid="deps-list" className="mt-3 space-y-2">
            {probe.kind === "probing" && (
              <li data-testid="deps-loading" className="text-muted-foreground text-xs">
                checking…
              </li>
            )}
            {/*
             * A FAILED PROBE SAYS SO (#237). Previously this state did not
             * exist: it was stored as `[]` and rendered as nothing at all, so
             * the panel a person opens to find out whether their backends are
             * reachable went silently blank exactly when they were not.
             */}
            {probe.kind === "failed" && (
              <li
                data-testid="deps-error"
                role="alert"
                className="text-destructive border-destructive/50 bg-destructive/15 rounded-md border px-3 py-2 text-xs"
              >
                Couldn’t probe dependencies: {probe.message}
              </li>
            )}
            {/*
             * And a probe that genuinely found nothing says THAT, rather than
             * leaving an empty box that reads the same as a failure.
             */}
            {probe.kind === "ok" && probe.rows.length === 0 && (
              <li
                data-testid="deps-empty"
                className="text-muted-foreground text-xs"
              >
                The probe ran and reported no dependencies.
              </li>
            )}
            {deps?.map((d) => {
              const shown = describeDependency(d.state);
              return (
                <li
                  key={d.id}
                  data-testid={`dep-${d.id}`}
                  data-state={d.state}
                  data-tone={shown.tone}
                  className="flex items-start justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <p className="text-foreground font-medium">{d.label}</p>
                    {d.detail && (
                      <p className="text-muted-foreground truncate">{d.detail}</p>
                    )}
                    {d.unverifiableBecause && (
                      <p
                        data-testid={`dep-${d.id}-why`}
                        className="text-muted-foreground"
                      >
                        {d.unverifiableBecause}
                      </p>
                    )}
                    {/*
                      A shortcut to the integration's own console. Present only
                      when there is an address a browser can actually open — the
                      resolver refuses to build one from an in-network host, and
                      says why instead, so this is never a dead control.
                    */}
                    {d.consoleUrl && (
                      <a
                        data-testid={`dep-${d.id}-console`}
                        href={d.consoleUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground mt-1 inline-flex items-center gap-1 underline underline-offset-2"
                      >
                        Open {d.label}
                        <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    )}
                    {!d.consoleUrl && d.consoleUnavailableBecause && (
                      <p
                        data-testid={`dep-${d.id}-console-why`}
                        className="text-muted-foreground"
                      >
                        {d.consoleUnavailableBecause}
                      </p>
                    )}
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`inline-block size-1.5 rounded-full ${
                        shown.tone === "success"
                          ? "bg-success"
                          : shown.tone === "destructive"
                            ? "bg-destructive"
                            : shown.tone === "info"
                              ? "bg-info"
                              : "bg-muted-foreground"
                      }`}
                    />
                    <span data-testid={`dep-${d.id}-label`}>{shown.label}</span>
                    {typeof d.latencyMs === "number" && (
                      <span className="text-muted-foreground">{d.latencyMs}ms</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              data-testid="deps-refresh"
              onClick={() => void loadDeps(false)}
              className="border-border rounded-md border px-2.5 py-1 text-xs"
            >
              Re-probe
            </button>
            <button
              type="button"
              data-testid="deps-verify-llm"
              // `refresh` — the button is labelled "spends a call", and served
              // from the cache it would spend nothing and return the answer
              // already on screen, which is what a person clicks it to doubt.
              onClick={() => void loadDeps(true, true)}
              disabled={verifying}
              className="border-border rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
            >
              {verifying ? "verifying…" : "Re-verify inference (spends a call)"}
            </button>
          </div>
        </section>

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
