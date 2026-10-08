// bb-plugin-bot-stage — what a lane needs to be drawn.
//
// The stage's components know nothing about BB's SDK: `app.tsx` turns a frame,
// the sidebar's thread list and the bot directory into these, and the preview
// harness builds them from a script. That is what lets the preview render the
// real lanes rather than a mock-up of them.
import type { ReactNode } from "react";
import type { FleetRow } from "../lib/fleet";
import type { Bot } from "../vendor/types";
import type { WorkspaceScene } from "../lib/workspace";

export type Variant = "compact" | "roomy";

export interface LaneModel {
  row: FleetRow;
  /** Who plays this lane. */
  bot: Bot;
  /** Not one of the user's own bots. */
  guest: boolean;
  /** Thread title, preferring the sidebar's. */
  title: string;
  /** Generated once from the opening message, never inferred from the title. */
  workspace?: WorkspaceScene | null;
  projectName: string | null;
  /** The agent provider's display name, for guests' name tags. */
  providerName: string | null;
  /** The provider's mark, drawn by the host. */
  badge: ReactNode;
  /** Blocked on a person, by either of the two sources that can tell. */
  waiting: boolean;
  /** Subagents at work under this thread. */
  helpers: number;
  /** Milliseconds since anything happened, aged between frames. */
  age: number;
  /** The thread this one was spawned under, by title. */
  parentTitle: string | null;
  /** Pinned in the sidebar, so the lane can offer to unpin it. */
  pinned?: boolean;
}

/** Sizes that depend on where the lanes are shown. */
export const SIZES = {
  compact: {
    /** Lane height. Fixed so the sidebar disclosure never changes height. */
    height: 136,
    actor: { width: 70, height: 70, k: 0.52, anchor: 0.38 },
    lines: 2,
    font: 11,
  },
  roomy: {
    height: 164,
    actor: { width: 146, height: 138, k: 0.95, anchor: 0.4 },
    lines: 4,
    font: 13,
  },
} as const satisfies Record<Variant, unknown>;

/** How long a lane takes to leave, in ms. Matches the CSS. */
export const EXIT_MS = 420;
