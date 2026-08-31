"use client";

import {
  envVarFor,
  labelFor,
  ALL_TOPOLOGIES,
  type AiBackend,
  type Runtime,
  type Topology,
} from "../lib/frameworks";

/**
 * The three axes of the chat surface — Framework, Runtime, Mode — as dropdowns.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE PAIR. THIS IS THE WHOLE POINT OF THIS FILE.
 *
 *     DISABLE WHAT THE USER CAN OBTAIN.  HIDE WHAT THEY CANNOT.
 *
 * Runtime and Mode follow OPPOSITE availability rules, on purpose, and the two
 * live in this one file so the asymmetry reads as a decision rather than as an
 * inconsistency someone forgot to clean up:
 *
 *   RUNTIME — unconfigured entries are PRESENT and DISABLED. A runtime that
 *   exists but has no URL in this deployment is obtainable: the fix is a line
 *   in .env.local. Hiding it would hide the remedy.
 *
 *   MODE — undeclared entries are ABSENT. A mode the manifest does not declare
 *   for the selected (rung, runtime) is not obtainable at all, and a disabled
 *   control still advertises a capability and invites a click that cannot
 *   succeed.
 *
 * A dropdown makes this easy to get wrong in BOTH directions. A `<select>` of
 * "the available options" silently deletes the disabled-but-obtainable runtime
 * and its remedy with it; a "render everything, disable what is unavailable"
 * loop resurrects the mode control that cannot be used. Swapping the two rules
 * produces a screen that still looks reasonable, which is why the tests in
 * ChatSelectors.test.tsx assert each rule by NAME and are mutation-verified
 * against the swap.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY A NATIVE <select> AND NOT A COMPOSED LISTBOX. #158 asked for a shadcn
 * `select.tsx` in packages/ui on the reasoning that DropdownMenu is for actions
 * and carries the wrong ARIA role, the wrong keyboard model and the wrong
 * announcement. That reasoning is right, and a native <select> satisfies it
 * maximally rather than approximately: it IS the platform's listbox, with
 * type-ahead, Home/End, mobile pickers and disabled-option announcement that no
 * hand-rolled version reproduces for free. It also adds nothing to
 * packages/ui — which every ejected fork carries — for a control the platform
 * already ships.
 *
 * The one thing a native <select> cannot do is render rich option content, so
 * the runtime remedy moved from `title` into the option's TEXT. That is an
 * improvement, not a workaround: `title` is a mouse-hover affordance, invisible
 * to keyboard and touch users and unread by most screen readers. The remedy is
 * now in the accessible name. The `title` is kept as well, for the pointer.
 */
export function ChatSelectors({
  frameworks,
  framework,
  onFramework,
  runtimes,
  runtime,
  availableRuntimes,
  onRuntime,
  modes,
  mode,
  onMode,
}: {
  frameworks: readonly { id: AiBackend; label: string }[];
  framework: AiBackend;
  onFramework: (id: AiBackend) => void;
  runtimes: readonly Runtime[];
  runtime: Runtime;
  /** Which runtimes this deployment has a URL for. Absent from here != absent from the list. */
  availableRuntimes: Record<Runtime, boolean>;
  onRuntime: (rt: Runtime) => void;
  /** The modes the selected (framework, runtime) actually declares. */
  modes: readonly Topology[];
  mode: Topology;
  onMode: (id: Topology) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Conversation axes"
      data-testid="chat-selectors"
      className="border-border flex flex-wrap items-center gap-3 rounded-lg border px-3 py-1.5"
    >
      <Axis
        id="framework"
        label="Framework"
        /*
         * The count is not decoration. Flat buttons showed the whole matrix at
         * a glance — 3 frameworks x 2 runtimes x 3 modes — and collapsing to
         * dropdowns hides it. Naming the size of each axis on the closed
         * control keeps the shape legible without expanding anything.
         */
        hint={`${frameworks.length}`}
        value={framework}
        onChange={onFramework}
      >
        {frameworks.map((f) => (
          <option key={f.id} value={f.id} data-testid={`framework-${f.id}`}>
            {f.label}
          </option>
        ))}
      </Axis>

      <Axis
        id="runtime"
        label="Runtime"
        hint={`${runtimes.length}`}
        value={runtime}
        onChange={onRuntime}
      >
        {/*
         * RULE 1 — PRESENT AND DISABLED. Every runtime this build knows about is
         * listed; the ones this deployment has no URL for cannot be picked and
         * say which env var would change that. Filtering this list is the
         * regression: it removes the entry AND the only place the remedy is
         * written down.
         */}
        {runtimes.map((rt) => {
          const configured = availableRuntimes[rt];
          const remedy = `${rt} — needs ${envVarFor(rt)} in .env.local`;
          return (
            <option
              key={rt}
              value={rt}
              disabled={!configured}
              data-testid={`runtime-${rt}`}
              title={configured ? rt : remedy}
            >
              {configured ? rt : remedy}
            </option>
          );
        })}
      </Axis>

      <Axis
        id="topology"
        label="Mode"
        /*
         * "2 of 3" rather than "2": the modes this cell does NOT serve are
         * absent from the list by rule, so without the total the reader cannot
         * tell a two-mode build from a two-mode cell of a three-mode build.
         * The count restores what absence removes, without resurrecting an
         * unusable control.
         */
        hint={`${modes.length} of ${ALL_TOPOLOGIES.length}`}
        value={mode}
        onChange={onMode}
      >
        {/*
         * RULE 2 — ABSENT, NOT GREYED. `modes` is what this (framework,
         * runtime) declares, and it is rendered whole. ALL_TOPOLOGIES is
         * counted against above and deliberately NOT iterated here: mapping it
         * with `disabled={!modes.includes(id)}` is the exact regression this
         * rule forbids, and it is the shape a careless conversion falls into.
         */}
        {modes.map((id) => {
          const { label, title } = labelFor(id);
          return (
            <option
              key={id}
              value={id}
              data-testid={`topology-${id}`}
              title={title}
            >
              {label}
            </option>
          );
        })}
      </Axis>
    </div>
  );
}

/**
 * One labelled axis. The <label> is bound with htmlFor rather than wrapping,
 * so the count in `hint` sits outside the accessible name — a screen reader
 * announces "Framework", not "Framework 3".
 */
function Axis<T extends string>({
  id,
  label,
  hint,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  value: T;
  onChange: (v: T) => void;
  children: React.ReactNode;
}) {
  const selectId = `chat-axis-${id}`;
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={selectId} className="text-muted-foreground text-xs">
        {label}
      </label>
      {/*
        NO OPACITY MODIFIER, AND THAT IS THE FIX (#474).

        This was `text-muted-foreground/60`, which composites #9c958a at 60% over
        --background #0d0d0d to #635f58 and measures 3.06:1 — under the 4.5:1 AA
        threshold, and this is 10px text, so the 3:1 large-text allowance does not
        apply. `aria-hidden` does not excuse it: assistive tech skips this node,
        everyone else reads it, and low vision without a screen reader is exactly
        the case the threshold is written for.

        `/80` would also clear AA, at 4.56:1 — by 0.06, which any future nudge to
        --df-muted erases silently. Dropping the modifier leaves 6.55:1 and uses
        the token as designed: `muted-foreground` IS the de-emphasis, so dimming
        it further was re-deriving a decision the theme already made.
      */}
      <span aria-hidden="true" className="text-muted-foreground text-[10px]">
        {hint}
      </span>
      <select
        id={selectId}
        data-testid={`${id}-select`}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="border-border text-foreground rounded-lg border bg-transparent px-2 py-1 text-xs font-medium"
      >
        {children}
      </select>
    </span>
  );
}
