import { describe, expect, it } from "vitest";
import {
  characterBudget,
  headOf,
  plainSegments,
  plainText,
  sliceSegments,
  Typewriter,
  visibleLength,
} from "./speech";

const text = (markdown: string) => plainText(plainSegments(markdown));

describe("plainSegments", () => {
  it("leaves a plain sentence alone", () => {
    expect(plainSegments("Found it.")).toEqual([{ text: "Found it.", code: false }]);
  });

  it("strips emphasis, headings, quotes and links but keeps the words", () => {
    expect(text("## Plan\n> **Bold** and *soft* and [a link](http://x.dev)")).toBe(
      "Plan\nBold and soft and a link",
    );
  });

  it("keeps inline code as its own run", () => {
    expect(plainSegments("Run `npm test` now")).toEqual([
      { text: "Run ", code: false },
      { text: "npm test", code: true },
      { text: " now", code: false },
    ]);
  });

  it("does not eat underscores inside identifiers", () => {
    expect(text("see snake_case_name and __init__ here")).toBe("see snake_case_name and init here");
  });

  it("turns list items into bullets and keeps numbers", () => {
    expect(text("- one\n* two\n1. three\n2) four")).toBe("• one\n• two\n1. three\n2) four");
  });

  it("drops blank lines and rules, so a bubble spends no room on gaps", () => {
    expect(text("a\n\n\nb\n---\nc")).toBe("a\nb\nc");
  });

  it("shows fenced code as code without the fences", () => {
    const segs = plainSegments("Try:\n```bash\nnpm i\nnpm test\n```\nDone");
    expect(plainText(segs)).toBe("Try:\nnpm i\nnpm test\nDone");
    expect(segs.some((seg) => seg.code && seg.text.includes("npm i"))).toBe(true);
  });

  it("never throws on junk", () => {
    expect(() => plainSegments("`` ` ** [ ]( ")).not.toThrow();
    expect(plainSegments("")).toEqual([]);
  });
});

describe("sliceSegments", () => {
  it("takes the first n visible characters across runs", () => {
    const segs = plainSegments("ab `cd` ef");
    expect(plainText(sliceSegments(segs, 4))).toBe("ab c");
    expect(sliceSegments(segs, 4).at(-1)?.code).toBe(true);
    expect(sliceSegments(segs, 0)).toEqual([]);
    expect(visibleLength(sliceSegments(segs, 999))).toBe(visibleLength(segs));
  });
});

describe("headOf", () => {
  it("passes a short message through untouched", () => {
    const segs = plainSegments("Short and sweet.");
    expect(headOf(segs, 100)).toEqual({ segs, cut: false });
  });

  it("cuts a long one at a word and says so", () => {
    const head = headOf(plainSegments("The quick brown fox jumps over the lazy dog today"), 24);
    const result = plainText(head.segs);
    expect(head.cut).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(24);
    expect(result).toBe("The quick brown fox…");
  });

  it("does not back up so far that the room is wasted", () => {
    const head = headOf(plainSegments("Supercalifragilisticexpialidocious and more words"), 20);
    expect(plainText(head.segs).length).toBeLessThanOrEqual(20);
    expect(plainText(head.segs).startsWith("Supercalifragilis")).toBe(true);
  });

  it("is a plain no-op for an absurdly small budget", () => {
    const segs = plainSegments("hello there");
    expect(headOf(segs, 2).cut).toBe(false);
  });
});

describe("characterBudget", () => {
  it("scales with width and lines", () => {
    expect(characterBudget(400, 12, 2)).toBeGreaterThan(characterBudget(200, 12, 2));
    expect(characterBudget(200, 12, 4)).toBe(characterBudget(200, 12, 2) * 2);
    expect(characterBudget(0, 12, 3)).toBeGreaterThan(0);
  });
});

describe("Typewriter", () => {
  it("reveals a new message from nothing, at speaking speed", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "x".repeat(90), false);
    expect(tw.visible).toBe(0);
    expect(tw.typing).toBe(true);
    expect(tw.step(500)).toBeGreaterThan(30);
    expect(tw.step(500)).toBeLessThan(91);
  });

  it("finishes a long message in about a second and a half, not a minute", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "x".repeat(480), false);
    let elapsed = 0;
    while (tw.typing && elapsed < 10_000) {
      tw.step(16);
      elapsed += 16;
    }
    expect(tw.typing).toBe(false);
    expect(elapsed).toBeLessThan(2_200);
  });

  it("shows a message from before you looked at once", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "old news", true);
    expect(tw.visible).toBe(8);
    expect(tw.typing).toBe(false);
  });

  it("keeps animating until the final character is visible", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "Hello", false);
    expect(tw.step(52)).toBe(4);
    expect(tw.typing).toBe(true);
    expect(tw.step(4)).toBe(5);
    expect(tw.typing).toBe(false);
  });

  it("carries on rather than restarting when the same message grows", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "Hello", false);
    tw.step(200);
    const before = tw.visible;
    expect(before).toBeGreaterThan(0);
    tw.setTarget("m1", "Hello there, friend", false);
    expect(tw.visible).toBe(before);
    expect(tw.typing).toBe(true);
  });

  it("starts over for a different message", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "first", true);
    tw.setTarget("m2", "second message", false);
    expect(tw.visible).toBe(0);
    expect(tw.currentId).toBe("m2");
  });

  it("pulls the cursor back if the same message now ends sooner", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "a long message indeed", true);
    tw.setTarget("m1", "short", false);
    expect(tw.visible).toBe(5);
    expect(tw.typing).toBe(false);
  });

  it("stays put when there is nothing left to say", () => {
    const tw = new Typewriter();
    tw.setTarget("m1", "", false);
    expect(tw.step(1_000)).toBe(0);
    expect(tw.typing).toBe(false);
  });
});
