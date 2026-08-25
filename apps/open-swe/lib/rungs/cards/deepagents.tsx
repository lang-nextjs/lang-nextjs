import { FileCard, SubAgentCard, TodoCard } from "@deepagents-nextjs/react";
import type { CardPack } from "./registry";

/**
 * RUNG-3-OWNED. The named imports are safe because eject deletes this file in the same pass
 * that prunes these three from the react barrel — they cannot disagree.
 */
const CARD = "w-full";

export const pack: CardPack = {
  "data-file": (d) => <FileCard file={d as never} className={CARD} />,
  "data-todo": (d) => <TodoCard todo={d as never} className={CARD} />,
  "data-sub-agent": (d) => <SubAgentCard subAgent={d as never} className={CARD} />,
};
