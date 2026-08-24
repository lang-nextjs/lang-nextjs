import { RUNGS, rungHref, assertNever, type Rung, type RungShape } from "@deepagents-nextjs/rungs";
import type { ComponentType } from "react";
import { MessagesSquare, ListChecks } from "lucide-react";
import type { NavGroup, NavItem } from "./types";

/**
 * The nav, derived from the rung manifest and GROUPED BY SHAPE.
 *
 * Nothing here enumerates rungs. Add a rung to rungs.json and it appears in the
 * group its shape names; there is no second list to update. That is the whole
 * reason `shape` is a declared manifest property rather than a nav constant.
 */

/** The heading a shape forms in the nav. Exhaustive: a new shape fails to compile. */
export function groupLabelForShape(shape: RungShape): string {
  switch (shape) {
    case "conversation":
      return "Conversation";
    case "run":
      return "Runs";
    default:
      return assertNever(shape);
  }
}

/**
 * A one-line description of why a rung is not reachable, or undefined if it is.
 * Read from manifest `state` — never from README, whose State column has
 * already drifted from the repo once.
 */
function noteFor(rung: Rung, href: string | null): string | undefined {
  if (href === null) return "Declared in the ladder, not present in this repo";
  if (rung.state === "external-required") return "Needs a service this repo cannot provide";
  if (rung.target.kind === "origin") return "Runs as a separate app on its own origin";
  return undefined;
}

/**
 * Icons, keyed by SHAPE rather than by rung id.
 *
 * Presentation lives here, not in rungs.json — an `icon` field in the manifest
 * would make every fork carry a value only this app reads, and the manifest is
 * an authority on what a rung IS, not on how one looks.
 *
 * Keyed by shape so a sixth rung gets an icon for free; keyed by id it would
 * need an edit here, which is the enumeration this file exists to avoid.
 * Exhaustive — a new shape fails to compile rather than rendering blank.
 */
function iconForShape(shape: RungShape): ComponentType<{ className?: string }> {
  switch (shape) {
    case "conversation":
      return MessagesSquare;
    case "run":
      return ListChecks;
    default:
      return assertNever(shape);
  }
}

export function rungNavGroups(env: Record<string, string | undefined> = {}): NavGroup[] {
  const byShape = new Map<RungShape, NavItem[]>();

  for (const rung of [...RUNGS].sort((a, b) => a.ordinal - b.ordinal)) {
    const href = rungHref(rung, env);
    const item: NavItem = {
      title: rung.id,
      href,
      icon: iconForShape(rung.shape),
      // A cross-origin target is a departure, not a tab. Marking it lets the
      // nav render it as leaving the app rather than pretending it routes here.
      external: rung.target.kind === "origin",
      note: noteFor(rung, href),
    };
    const list = byShape.get(rung.shape);
    if (list) list.push(item);
    else byShape.set(rung.shape, [item]);
  }

  return [...byShape.entries()].map(([shape, items]) => ({
    label: groupLabelForShape(shape),
    items,
  }));
}

/**
 * Routes that are NOT rungs. Kept in their own group on purpose: they are test
 * harnesses, and folding them in beside rungs would imply the ladder has eight
 * steps. They are also not in the manifest, and should not be — `owns` and
 * `target` describe rungs, and a harness is neither.
 */
export const HARNESS_GROUP: NavGroup = {
  label: "Harnesses",
  items: [
    { title: "Dashboard", href: "/dashboard" },
    { title: "HITL demo", href: "/hitl-demo" },
    { title: "Concurrent", href: "/concurrent-test" },
    { title: "Reconnect", href: "/reconnect-test" },
  ],
};
