// bb-plugin-bot-stage — the stage with its title bar: what the sidebar peek,
// the floating monitor and the full page all show.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useUiSize } from "../lib/ui-size";
import { Options } from "./Options";
import { Close, PopOut } from "./glyphs";
import { Stage } from "./Stage";
import { type LaneModel, type Variant } from "./model";

export interface PanelProps {
  lanes: readonly LaneModel[];
  variant: Variant;
  /** Lanes tall enough to show before the list scrolls (compact only). */
  visibleLanes?: number;
  title?: string;
  floating?: boolean;
  stale?: boolean;
  onlyWorking: boolean;
  onToggleWorking: () => void;
  onOpen: (threadId: string, split: boolean) => void;
  onDismiss?: (threadId: string) => void;
  onTogglePin?: (threadId: string, pinned: boolean) => void;
  onClose?: () => void;
  onPopout?: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onNudge?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** Extra controls at the right of the title bar. */
  trailing?: ReactNode;
  /** Between the title bar and the lanes: starting a thread with a bot. */
  spawn?: ReactNode;
  /** Under the lanes: pinned and recent threads. */
  threadsMenu?: ReactNode;
}

export function Panel(props: PanelProps) {
  const { lanes, variant, floating = false } = props;
  const workspace = useUiSize("workspace");
  const details = useUiSize("details");
  const working = lanes.filter((lane) => lane.row.busy).length;
  const needed = lanes.filter((lane) => lane.waiting).length;
  const files = lanes.reduce((total, lane) => total + lane.row.files.length, 0);

  // Whether the list continues below the fold: three lanes of a fleet of
  // twenty behind an auto-hiding scrollbar looks like the whole fleet.
  const list = useRef<HTMLUListElement | null>(null);
  const [more, setMore] = useState(false);
  const [listCap, setListCap] = useState<number>();
  const visibleLanes = props.visibleLanes ?? 5;
  const laneIds = lanes.map((lane) => lane.row.id).join(",");
  const measure = useCallback(() => {
    const element = list.current;
    if (element === null) return;
    const visible = Array.from(element.children).slice(0, visibleLanes) as HTMLElement[];
    const last = visible.at(-1);
    const height = last === undefined ? 0 : last.offsetTop + last.offsetHeight - (visible[0]?.offsetTop ?? 0);
    setListCap(height > 0 ? height : undefined);
    setMore(element.scrollHeight - element.scrollTop - element.clientHeight > 4);
  }, [visibleLanes]);
  useLayoutEffect(() => {
    measure();
    const element = list.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, laneIds, workspace, details]);

  return (
    <div className="bst-panel" data-floating={floating} data-variant={variant}
      style={{ "--bst-workspace-scale": workspace / 100, "--bst-details-scale": details / 100 } as CSSProperties}>
      <header
        className="bst-bar"
        data-draggable={floating}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest("button, input, .bst-options") !== null) return;
          props.onDragStart?.(event);
        }}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget) props.onNudge?.(event);
        }}
        tabIndex={floating ? 0 : undefined}
        role={floating ? "group" : undefined}
        aria-label={floating ? "Bot Stage popout — move it with the arrow keys" : undefined}
      >
        <span className="bst-grow" aria-hidden />
        <button
          type="button"
          className="bst-count"
          aria-pressed={props.onlyWorking}
          onClick={props.onToggleWorking}
          title={
            props.onlyWorking
              ? "Showing only bots that are working or waiting on you — click to show everyone"
              : `${working} of ${lanes.length} working${needed > 0 ? `, ${needed} waiting on you` : ""} · ${files} files touched in the last minute — click to show only live bots`
          }
        >
          {lanes.length === 0
            ? ""
            : props.onlyWorking
              ? `live only · ${working}/${lanes.length}`
              : needed > 0
                ? `${needed} waiting · ${working}/${lanes.length}`
                : `${working}/${lanes.length} working`}
        </button>
        {props.trailing}
        <Options workspace={workspace} details={details} />
        {props.onPopout === undefined ? null : (
          <button type="button" className="bst-icon" onClick={props.onPopout} aria-label="Pop out Bot Stage" title="Pop out Bot Stage">
            <PopOut />
          </button>
        )}
        {props.onClose === undefined ? null : (
          <button
            type="button"
            className="bst-icon"
            onClick={props.onClose}
            aria-label={floating ? "Close Bot Stage popout" : "Close Bot Stage"}
            title={floating ? "Close Bot Stage popout" : "Close Bot Stage"}
          >
            <Close />
          </button>
        )}
      </header>

      {props.spawn}

      <Stage
        lanes={lanes}
        variant={variant}
        workspaceScale={workspace / 100}
        onOpen={props.onOpen}
        onDismiss={props.onDismiss}
        onTogglePin={props.onTogglePin}
        listRef={list}
        onScroll={measure}
        className={`${more ? "bst-fade-bottom" : ""} ${floating ? "bst-floating-list" : ""}`}
        style={variant === "compact" && listCap !== undefined ? { maxHeight: `min(${listCap}px, 38vh)` } : undefined}
        empty={
          <p className="bst-empty">
            {props.stale
              ? "Bot Stage cannot reach the server right now."
              : props.onlyWorking
                ? "Nobody is working right now."
                : "The stage is empty. Start a thread and its bot walks on."}
          </p>
        }
      />
      {props.threadsMenu}
    </div>
  );
}
