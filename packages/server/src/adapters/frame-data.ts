/**
 * A FRAME WITHOUT `data` IS INVALID FOR EVERY `data-*` VARIANT (#971).
 *
 * Both enrich adapters wrapped `JSON.stringify({type, data})` in a try/catch whose fallback
 * emitted `{type, error: "<unserializable>"}` — dropping `data` entirely. The frame contract
 * requires `["type", "data"]` on all TWELVE `data-*` variants, so that fallback violated every
 * one of them rather than a single frame's shape.
 *
 * THE THIRD PRODUCER ALREADY DID IT RIGHT, and it is what this copies. `approval-gating.ts`
 * re-emits the SAME object with `arguments: "<unserializable>"` and every other field intact,
 * so `data` survives and so do the variant's own required fields. The adapters could not do
 * that literally because `dataFrame(type, data)` is generic and does not know which key is
 * risky — so the substitution is per key.
 *
 * WHY NOT `data: {error: "<unserializable>"}`. That satisfies the frame level and still breaks
 * three variants which require fields INSIDE `data`, one of which — `data-approval-required` —
 * `sdaEnrich` actually emits, carrying `arguments: input` where `input` is arbitrary tool
 * input. So a whole-payload sentinel would leave that frame invalid WHENEVER THIS BRANCH RUNS,
 * which is why the substitution is per key — and that holds however often it runs.
 *
 * IT IS NOT REACHABLE TODAY, AND AN EARLIER DRAFT OF THIS PARAGRAPH SAID THE OPPOSITE. Both
 * adapters reach their payload through `JSON.parse` — sdaEnrich.ts:356, openSweEnrich.ts:187 —
 * so every value in `data` is plain JSON and nothing in it can fail to stringify. The
 * selftest's header carries that measurement; this file contradicted it, and the source is
 * where a reader greps first, so the false half was the discoverable half.
 */
export const UNSERIALIZABLE = "<unserializable>";

/**
 * The same keys, with any value JSON cannot represent replaced by the sentinel.
 *
 * Per KEY rather than whole-payload: a cycle always runs through at least one value that
 * cannot be stringified alone, so testing each key finds it while leaving its siblings — the
 * id, the seq, the status — intact and the frame contract-valid.
 */
export function serialisableData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    try {
      JSON.stringify(value);
      out[key] = value;
    } catch {
      out[key] = UNSERIALIZABLE;
    }
  }
  return out;
}

/**
 * `data: ${JSON.stringify({type, data})}`, degrading in stages rather than dropping `data`.
 *
 * The last resort still carries a `data` OBJECT, because the frame-level requirement is the
 * one invariant that must hold whatever the payload does. It loses a variant's inner fields;
 * it does not emit a frame no variant can describe.
 */
export function dataFrameRaw(
  type: string,
  data: Record<string, unknown>
): string {
  try {
    return `data: ${JSON.stringify({ type, data })}`;
  } catch {
    try {
      return `data: ${JSON.stringify({ type, data: serialisableData(data) })}`;
    } catch {
      return `data: ${JSON.stringify({
        type,
        data: { error: UNSERIALIZABLE },
      })}`;
    }
  }
}
