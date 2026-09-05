"use client";

import { useEffect, useRef, useState } from "react";
import {
  processingDetail,
  processingVerb,
  shouldShowProcessing,
  type ProcessingState,
  type Usage,
} from "./processing-status";

export interface ProcessingRowProps extends ProcessingState {
  /** When this turn was submitted, in ms. The timer measures from here. */
  startedAt: number | null;
  usage?: Usage | null;
  className?: string;
}

/**
 * The row that occupies the assistant's position while the reply is being
 * produced (#231).
 *
 * SHARED, NOT open-swe's. Every rung gets a processing indicator, so this lives
 * in packages/react and imports no adapter — it must survive `pnpm eject` at
 * all five rungs (criterion 5). Everything it renders comes from `status`, an
 * optional tool name, and a start time.
 *
 * THE LIVE REGION ANNOUNCES THE VERB, NOT THE TICK (criterion 6). A timer that
 * re-announces every second is unusable with a screen reader, so the ticking
 * duration is marked `aria-hidden` and only the verb sits inside the polite
 * region. That is also why the verb and the duration are separate elements
 * rather than one interpolated string.
 */
export function ProcessingRow({
  status,
  activeTool,
  hasText,
  startedAt,
  usage,
  className,
}: ProcessingRowProps) {
  const visible = shouldShowProcessing({ status, activeTool, hasText });
  const [now, setNow] = useState<number>(() => Date.now());
  const started = useRef<number | null>(startedAt);
  if (startedAt !== null) started.current = startedAt;

  useEffect(() => {
    if (!visible) return;
    // THE TIMER STOPS AT BOTH ENDS (criterion 3). The interval is torn down the
    // moment the row is not visible — complete, error or cancel all land there —
    // because a counter still climbing after the stream ended is reporting
    // activity that is not happening.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible || started.current === null) return null;

  const verb = processingVerb({ status, activeTool, hasText });
  const detail = processingDetail(now - started.current, usage);

  return (
    <div
      data-testid="processing-row"
      data-verb={verb}
      role="status"
      aria-live="polite"
      className={
        className ??
        "text-muted-foreground flex items-center gap-2 px-1 py-2 text-sm"
      }
    >
      {/*
       * `motion-safe:` rather than an unconditional animation — under
       * prefers-reduced-motion the glyph holds still while the text keeps
       * updating, which is the behaviour criterion 6 asks for. Marked
       * aria-hidden because a decorative glyph read aloud is noise.
       */}
      <span aria-hidden="true" className="motion-safe:animate-pulse">
        ✶
      </span>
      <span>{verb}…</span>
      {/*
       * OUTSIDE the announced text, deliberately: this changes every second,
       * and a polite region re-reading it makes the row unusable.
       */}
      <span aria-hidden="true" data-testid="processing-detail">
        ({detail})
      </span>
    </div>
  );
}
