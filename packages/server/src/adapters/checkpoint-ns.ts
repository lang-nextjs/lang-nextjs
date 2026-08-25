/**
 * LangGraph `checkpoint_ns` → provider-neutral FrameAttribution.
 *
 * Lives under adapters/ because the FORMAT is LangGraph-specific; the SHAPE it produces
 * (accumulator.ts's FrameAttribution) is not. Both LangGraph-flavoured adapters — openSwe.ts
 * and langgraph.ts — use this, so that fixing attribution for the dashboard does not leave
 * the sibling adapter behind. (Issue #38.)
 *
 * The namespace is pipe-delimited, one segment per graph level, each `<node>:<uuid>`:
 *
 *   root graph      parent_node:1f0a…
 *   one level down  call_sub:1f0b…|sub_tool_node:1f0c…
 *
 * So segment count IS the nesting level, and the uuids are what distinguish two concurrent
 * invocations of the same node. Both facts are load-bearing: drop the uuids and sibling
 * sub-agents collapse together; drop the segments and depth is unrecoverable.
 *
 * Two dead ends, recorded so nobody re-derives them (verified by DEV2 against a live server):
 *   - `parent_ids` is null on every frame.
 *   - `streamSubgraphs: true` governs `.stream()`, not `streamEvents`; it changes nothing here.
 */
import type { FrameAttribution } from "../accumulator";

/** Split a checkpoint_ns into its per-level segments. `null` when there is nothing usable. */
export function parseCheckpointNs(ns: unknown): string[] | null {
  if (typeof ns !== "string") return null;
  const segments = ns.split("|").filter((s) => s.length > 0);
  return segments.length > 0 ? segments : null;
}

/** `call_sub:1f0b…` → `call_sub`. A segment with no uuid is already its own label. */
export function segmentLabel(segment: string): string {
  const colon = segment.indexOf(":");
  return colon === -1 ? segment : segment.slice(0, colon);
}

/**
 * Per-stream scope registry.
 *
 * scopeIds are minted on first sight (`s1`, `s2`, …) and held for the life of the stream,
 * mirroring how `seq` already works in these adapters. Chosen over hashing the namespace
 * because it is uuid-free, debuggable, collision-free by construction, and needs no crypto —
 * at the cost of not being stable across streams, which `seq` already is not.
 */
export function createScopeRegistry(): (
  ns: unknown
) => FrameAttribution | undefined {
  const idByNs = new Map<string, string>();
  let minted = 0;

  const idFor = (nsKey: string): string => {
    let id = idByNs.get(nsKey);
    if (id === undefined) {
      id = `s${++minted}`;
      idByNs.set(nsKey, id);
    }
    return id;
  };

  return function attributionFor(ns: unknown): FrameAttribution | undefined {
    const segments = parseCheckpointNs(ns);
    // No namespace at all — say nothing rather than assert a depth we did not observe. An
    // absent `attribution` is meaningfully different from `depth: 0`, which is a measurement.
    if (segments === null) return undefined;

    const depth = segments.length - 1;
    return {
      depth,
      path: segments.map(segmentLabel),
      scopeId: idFor(segments.join("|")),
      parentScopeId:
        depth === 0 ? null : idFor(segments.slice(0, -1).join("|")),
    };
  };
}
