import { describe, expect, it } from "vitest";
import { bodyOf } from "./BotPixel";
import type { Bot } from "../vendor/types";

const bot: Bot = {
  id: "b1",
  name: "Business Coach",
  mainThreadId: null,
  avatar: { color: "#f0b429", shape: "squircle", expression: "calm", motion: "float" },
};

/** The eye blocks: the dark ones, which the tie and hat do not share. */
const eyes = (gaze?: { x: -1 | 0 | 1; y: -1 | 0 | 1 }) =>
  bodyOf(bot, gaze).extras.filter((rect) => rect[4] === "#101713");

describe("a bot's picture", () => {
  it("looks straight ahead unless told otherwise", () => {
    expect(eyes()).toEqual(eyes({ x: 0, y: 0 }));
  });

  it("moves its eyes one block toward where it is looking", () => {
    const ahead = eyes();
    const right = eyes({ x: 1, y: 0 });
    const down = eyes({ x: 0, y: 1 });
    expect(right).toHaveLength(ahead.length);
    for (const [index, block] of right.entries()) {
      expect(block[0]).toBeGreaterThan(ahead[index]![0]);
      expect(block[1]).toBe(ahead[index]![1]);
    }
    for (const [index, block] of down.entries()) {
      expect(block[1]).toBeGreaterThan(ahead[index]![1]);
      expect(block[0]).toBe(ahead[index]![0]);
    }
  });

  it("leaves the body and its accessory where they are", () => {
    const still = bodyOf(bot);
    const looking = bodyOf(bot, { x: -1, y: 1 });
    expect(looking.cells).toEqual(still.cells);
    const accessory = (parts: ReturnType<typeof bodyOf>) => parts.extras.filter((rect) => rect[4] !== "#101713");
    expect(accessory(looking)).toEqual(accessory(still));
  });
});
