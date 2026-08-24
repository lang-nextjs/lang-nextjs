import { FileCard, SubAgentCard, TodoCard } from "@deepagents-nextjs/react";
import type { DataFile, DataSubAgent, DataTodo } from "@deepagents-nextjs/react";
import type { CardPack } from "./registry";

/**
 * RUNG-3-OWNED. Declared in rungs.json under `deepagents.owns.ts`, so `pnpm eject` deletes
 * this file with the rung and prunes the barrel line that re-exported it.
 *
 * These three cards render parts that deepagentsEnrich emits. Rung 4 inherits them through
 * `requires`, which is why they belong to rung 3 rather than being duplicated — assign a
 * card to the LOWEST rung that emits its payload.
 *
 * Naming the cards here is correct precisely because this file dies with them. The same
 * import from a shared file is the defect severability.test.ts exists to catch.
 */
const BUBBLE = "max-w-sm rounded-xl border px-4 py-2 text-sm";
const PLAIN = `${BUBBLE} bg-card border-border`;

export const pack: CardPack = {
  "data-file": (data) => <FileCard file={data as DataFile} className={PLAIN} />,
  "data-sub-agent": (data) => (
    <SubAgentCard subAgent={data as DataSubAgent} className={PLAIN} />
  ),
  "data-todo": (data) => <TodoCard todo={data as DataTodo} className={PLAIN} />,
};
