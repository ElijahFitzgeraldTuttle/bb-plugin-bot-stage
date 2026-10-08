// bb-plugin-bot-stage — the strip of bots you can open or start a thread with.
//
// Presentation only: it is told which bots there are and which one has its
// composer open, and shows whatever the host renders for that bot beneath.
// Click a bot to go to its last thread; shift-click starts a fresh one.
import type { ReactNode } from "react";
import type { Bot } from "../contract";
import { toStageBot } from "./cast";
import { BotPixel, type Gaze } from "./BotPixel";

export type SpawnStatus = "live" | "needs";

export interface SpawnRailProps {
  bots: readonly Bot[];
  /** The bot whose composer is open. */
  pickedId: string | null;
  /** Bots with a thread on stage that is working, or waiting on you. */
  status: Readonly<Record<string, SpawnStatus>>;
  /** Bots that already have a thread to go back to. */
  hasThread: ReadonlySet<string>;
  onOpen: (botId: string) => void;
  onNew: (botId: string) => void;
  /** Where the picked bot is looking while you write to it. */
  gaze?: Gaze;
  /** The composer for the picked bot. */
  children?: ReactNode;
}

export function SpawnRail({ bots, pickedId, status, hasThread, onOpen, onNew, gaze, children }: SpawnRailProps) {
  if (bots.length === 0) return null;
  return (
    <div className="bst-spawn">
      <div className="bst-rail" role="toolbar" aria-label="Open a bot, or start a new thread with it">
        {bots.map((bot) => {
          const returning = hasThread.has(bot.id);
          return (
            <span key={bot.id} className="bst-rail-item">
              <button
                type="button"
                className="bst-rail-bot"
                aria-pressed={pickedId === bot.id}
                aria-label={returning ? `Open ${bot.name}'s last thread` : `New thread with ${bot.name}`}
                title={
                  returning
                    ? `${bot.name} — open last thread · Shift-click for a new one`
                    : `${bot.name} — new thread`
                }
                onClick={(event) => (returning && !event.shiftKey ? onOpen(bot.id) : onNew(bot.id))}
              >
                <BotPixel bot={toStageBot(bot)} gaze={pickedId === bot.id ? gaze : undefined} />
                {status[bot.id] === undefined ? null : <span className="bst-rail-dot" data-state={status[bot.id]} aria-hidden />}
              </button>
            </span>
          );
        })}
      </div>
      {children}
    </div>
  );
}
