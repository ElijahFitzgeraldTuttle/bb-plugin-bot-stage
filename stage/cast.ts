// bb-plugin-bot-stage — who plays each lane.
//
// A thread owned by one of the user's bots is played by that bot, with its
// own colour, shape and accessory. A thread no bot owns still needs someone
// on stage, so it gets a guest: a muted, deterministic character that is
// plainly not one of the user's own.
import type { Bot as WireBot } from "../contract";
import type { Bot } from "../vendor/types";

const GUEST_COLOURS = ["#9fb3a8", "#a8a8c4", "#c4b3a0", "#a0b8c4", "#c4a8b3", "#b3c4a0"];
const GUEST_SHAPES = ["round", "squircle", "capsule", "blob", "cloud", "hexagon", "triangle"];

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return value;
}

/** The renderer's shape of a bot, from what the server sent. */
export function toStageBot(bot: WireBot): Bot {
  return { id: bot.id, name: bot.name, avatar: bot.avatar, mainThreadId: null };
}

/** A stand-in for a thread that no bot owns. Stable for the same thread. */
export function guestBot(threadId: string, label: string | null): Bot {
  const seed = hash(threadId);
  return {
    id: `guest_${threadId}`,
    name: label ?? "Guest",
    avatar: {
      color: GUEST_COLOURS[seed % GUEST_COLOURS.length] as string,
      shape: GUEST_SHAPES[(seed >>> 8) % GUEST_SHAPES.length] as string,
      expression: "calm",
      motion: "float",
    },
    mainThreadId: null,
  };
}

/** Is this one of the user's own bots, rather than a guest? */
export function isGuest(bot: Bot): boolean {
  return bot.id.startsWith("guest_");
}

/** A tint of the bot's colour for halos and borders, safe on any theme. */
export function glowOf(bot: Bot, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/iu.exec(bot.avatar.color)?.[1];
  if (hex === undefined) return `rgba(124, 207, 154, ${alpha})`;
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}
