// bb-plugin-bot-stage — the list of lanes, and how it moves.
//
// Lanes drop in one after another the first time the stage fills, drop in
// alone when a thread joins, slide to their new place when the order changes
// (FLIP, so a thread that starts needing you visibly steps to the front) and
// fold away when a thread leaves.
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { Lane } from "./Lane";
import { useExitList, useFlip } from "./hooks";
import { EXIT_MS, type LaneModel, type Variant } from "./model";

/** For this long after the stage appears, lanes drop in staggered. */
const INTRO_MS = 900;

export interface StageProps {
  lanes: readonly LaneModel[];
  variant: Variant;
  workspaceScale?: number;
  onOpen: (threadId: string, split: boolean) => void;
  onDismiss?: (threadId: string) => void;
  /** Shown instead of the list when there is nothing to put on stage. */
  empty?: ReactNode;
  className?: string;
  onScroll?: () => void;
  listRef?: React.RefObject<HTMLUListElement | null>;
  style?: React.CSSProperties;
}

export function Stage({ lanes, variant, workspaceScale = 1, onOpen, onDismiss, empty, className, onScroll, listRef, style }: StageProps) {
  const own = useRef<HTMLUListElement | null>(null);
  const ref = listRef ?? own;
  const born = useRef(performance.now());
  const items = useMemo(() => lanes.map((lane) => ({ id: lane.row.id, lane })), [lanes]);
  const shown = useExitList(items, EXIT_MS);
  useFlip(ref, shown.map((entry) => `${entry.item.id}${entry.leaving ? "~" : ""}`).join(","));

  if (lanes.length === 0 && shown.length === 0) return <>{empty ?? null}</>;
  const intro = performance.now() - born.current < INTRO_MS;
  return (
    <ul ref={ref} className={`bst-list ${className ?? ""}`} data-variant={variant} onScroll={onScroll} style={style}>
      {shown.map((entry, index) => (
        <Lane
          key={entry.item.id}
          model={entry.item.lane}
          variant={variant}
          workspaceScale={workspaceScale}
          index={intro ? index : 0}
          entering
          leaving={entry.leaving}
          onOpen={onOpen}
          onDismiss={onDismiss}
        />
      ))}
    </ul>
  );
}
