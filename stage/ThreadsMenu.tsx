// bb-plugin-bot-stage — a drop-down under the stage: pinned threads, then the
// ones you touched most recently. Presentation only; it is handed the rows.
import { useEffect, useState } from "react";
import { formatAge } from "../lib/fleet";
import type { Bot as StageBot } from "../vendor/types";
import { BotPixel } from "./BotPixel";
import { Chevron, Pin } from "./glyphs";

export interface ThreadItem {
  id: string;
  title: string;
  /** The bot that owns the thread, if one does. */
  bot: StageBot | null;
  /** How long since the thread was last touched. */
  ageMs: number;
  pinned: boolean;
  state: "live" | "needs" | null;
}

export interface ThreadsMenuProps {
  open: boolean;
  onToggle: () => void;
  pinned: readonly ThreadItem[];
  recent: readonly ThreadItem[];
  currentId: string | null;
  onOpen: (threadId: string, split: boolean) => void;
  /** Pin it (`true`) or unpin it (`false`). */
  onTogglePin: (threadId: string, pinned: boolean) => void;
}

function Row({ item, current, onOpen, onTogglePin }: { item: ThreadItem; current: boolean } & Pick<ThreadsMenuProps, "onOpen" | "onTogglePin">) {
  return (
    <li className="bst-thread" data-current={current} data-state={item.state ?? undefined}>
      <button
        type="button"
        className="bst-thread-open"
        title={item.title}
        onClick={(event) => onOpen(item.id, event.shiftKey || event.metaKey || event.ctrlKey)}
      >
        <span className="bst-thread-who" aria-hidden>
          {item.bot === null ? <i className="bst-thread-anon" /> : <BotPixel bot={item.bot} size={26} />}
          {item.state === null ? null : <span className="bst-rail-dot" data-state={item.state} />}
        </span>
        <span className="bst-thread-title">{item.title}</span>
        <span className="bst-thread-age">{formatAge(item.ageMs)}</span>
      </button>
      <button
        type="button"
        className="bst-thread-pin"
        aria-pressed={item.pinned}
        aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
        title={item.pinned ? "Unpin" : "Pin"}
        onClick={() => onTogglePin(item.id, !item.pinned)}
      >
        <Pin />
      </button>
    </li>
  );
}

/** How long the drop-down takes to close; the body stays mounted until then. */
const CLOSE_MS = 240;

export function ThreadsMenu({ open, onToggle, pinned, recent, currentId, onOpen, onTogglePin }: ThreadsMenuProps) {
  // Opening mounts the body shut and lets it grow on the next frame; closing
  // shrinks it first and unmounts once that has played. A menu that starts open
  // is simply open: no animation on load.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <div className="bst-threads" data-open={open}>
      <button type="button" className="bst-threads-head" aria-expanded={open} onClick={onToggle}>
        <span>Threads</span>
        <Chevron className="bst-threads-chevron" />
      </button>
      {mounted ? (
        <div className="bst-threads-reveal" data-shown={shown}>
          <div className="bst-threads-clip">
            <div className="bst-threads-body">
              {pinned.length > 0 ? (
                <>
                  <h3 className="bst-threads-label">Pinned</h3>
                  <ul className="bst-threads-list">
                    {pinned.map((item) => (
                      <Row key={item.id} item={item} current={item.id === currentId} onOpen={onOpen} onTogglePin={onTogglePin} />
                    ))}
                  </ul>
                </>
              ) : null}
              <h3 className="bst-threads-label">Recent</h3>
              {recent.length === 0 ? (
                <p className="bst-threads-empty">Nothing recent.</p>
              ) : (
                <ul className="bst-threads-list">
                  {recent.map((item) => (
                    <Row key={item.id} item={item} current={item.id === currentId} onOpen={onOpen} onTogglePin={onTogglePin} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
