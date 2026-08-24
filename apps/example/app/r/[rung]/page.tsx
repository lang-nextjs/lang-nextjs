import { notFound } from "next/navigation";
import {
  RUNGS, RUNG_BY_ID, assertNever, type Rung, type RungId,
} from "@deepagents-nextjs/rungs";
import { RunDeparture } from "../../../components/shell/RunDeparture";
import { ConversationMount } from "../../../components/shell/ConversationMount";

/**
 * `/r/[rung]` — THE SHAPE-ROUTED SURFACE.
 *
 * `rungs.json` has been declaring `target.route: "/r/[rung]"` for rungs 1-3
 * since the manifest landed, and the route did not exist. This is it.
 *
 * The dispatch below is the whole point of #23's ruling. It is NOT a tab bar
 * that swaps content: a `conversation` rung and a `run` rung take genuinely
 * different code paths and produce different information architecture. Adding a
 * shape to the manifest without adding a branch here fails to COMPILE, via
 * assertNever — the compiler names the file that has to change.
 */
export function generateStaticParams(): { rung: RungId }[] {
  // Every rung is addressable, including one declared but absent — a planned
  // rung gets an honest "declared, not in this repo" surface rather than a 404,
  // because it IS in the ladder. Derived, so a sixth rung needs no edit here.
  return RUNGS.map((r) => ({ rung: r.id }));
}

export default async function RungRoute({
  params,
}: {
  params: Promise<{ rung: string }>;
}) {
  const { rung: id } = await params;
  const rung: Rung | undefined = RUNG_BY_ID[id as RungId];

  // An id that is not in the manifest is a real 404. The manifest is the
  // authority on what a rung is, so "not in RUNGS" is the definition of unknown.
  if (!rung) notFound();

  switch (rung.shape) {
    case "conversation":
      return <ConversationMount rung={rung} />;
    case "run":
      return <RunDeparture rung={rung} />;
    default:
      return assertNever(rung.shape);
  }
}
