// bb-plugin-bot-stage — what a bot does for a given thread state.
//
// The companion renderer already knows how to look thoughtful, busy, alarmed,
// pleased, failed or asleep. This module decides which of those a lane is, from
// facts the fleet frame carries. It is pure, and it holds the one piece of
// memory the decision needs — "did it just finish?" — in an object the caller
// owns, so it is testable without a canvas or a clock.
//
// It is deliberately about the thread alone. Being picked up or hovered are
// things that happen to the drawn bot, so the actor layers those on top; the
// lane's label, colours and ring come from this, and keep working on a machine
// that cannot draw the bot at all.
import type { Mood } from "../vendor/sprites";
import type { Work } from "../vendor/types";

/** How long a bot celebrates (or sulks) after its thread stops. */
export const AFTERGLOW_MS = 3_000;
/** Quiet this long and a bot nods off. */
export const SLEEP_AFTER_MS = 5 * 60_000;

/** Item kinds that are the agent talking or thinking rather than doing. */
const NOT_WORK = new Set(["agentMessage", "reasoning", "plan", "planSteps"]);

/** Which prop to mime for an item kind. */
export function workOf(kind: string | null): Work {
  switch (kind) {
    case "commandExecution":
    case "backgroundTask":
      return "run";
    case "fileRead":
      return "read";
    case "search":
      return "search";
    case "webFetch":
    case "webSearch":
      return "web";
    case "fileChange":
      return "edit";
    default:
      return "tool";
  }
}

export interface MoodInput {
  /** Blocked on a person. */
  waiting: boolean;
  /** The thread's last turn failed. */
  failed: boolean;
  /** The thread is working (the frame's own verdict). */
  busy: boolean;
  /** The bubble is still revealing words. */
  speaking: boolean;
  /** A tool call has started and not returned. */
  inFlight: boolean;
  /** What that call is, when there is one. */
  kind: string | null;
  /** How long since anything happened on the thread. */
  quietMs: number;
}

export interface MoodMemory {
  /** Was it active (working or speaking) the last time we looked? */
  wasActive: boolean;
  /** When it stopped, and whether it stopped badly. */
  endedAt: number;
  endedBadly: boolean;
}

export function newMemory(input: MoodInput): MoodMemory {
  // A lane that is already quiet when it appears has not just finished.
  return { wasActive: input.busy || input.speaking, endedAt: -Infinity, endedBadly: false };
}

export interface Pose {
  mood: Mood;
  work: Work | null;
}

/**
 * The pose for this instant. Priority, highest first: needs you, failed,
 * speaking, working, thinking, just finished, asleep, idle. Updates `memory`
 * when activity stops.
 */
export function chooseMood(input: MoodInput, memory: MoodMemory, now: number): Pose {
  const active = input.busy || input.speaking;
  if (memory.wasActive && !active) {
    memory.endedAt = now;
    memory.endedBadly = input.failed;
  }
  memory.wasActive = active;

  if (input.waiting) return { mood: "needs", work: null };
  if (input.failed) return { mood: "failed", work: null };
  if (input.speaking) return { mood: "talking", work: null };
  if (input.busy) {
    const doing = input.inFlight && !NOT_WORK.has(input.kind ?? "");
    return doing
      ? { mood: "working", work: workOf(input.kind) }
      : { mood: "thinking", work: null };
  }
  if (now - memory.endedAt < AFTERGLOW_MS) {
    return { mood: memory.endedBadly ? "failed" : "done", work: null };
  }
  if (input.quietMs > SLEEP_AFTER_MS) return { mood: "sleeping", work: null };
  return { mood: "idle", work: null };
}
