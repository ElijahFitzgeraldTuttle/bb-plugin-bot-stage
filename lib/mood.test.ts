import { describe, expect, it } from "vitest";
import {
  AFTERGLOW_MS,
  chooseMood,
  newMemory,
  SLEEP_AFTER_MS,
  workOf,
  type MoodInput,
} from "./mood";

const base: MoodInput = {
  waiting: false,
  failed: false,
  busy: false,
  speaking: false,
  inFlight: false,
  kind: null,
  quietMs: 10_000,
};
const input = (over: Partial<MoodInput> = {}): MoodInput => ({ ...base, ...over });

describe("workOf", () => {
  it("mimes the right prop for each kind of item", () => {
    expect(workOf("commandExecution")).toBe("run");
    expect(workOf("fileRead")).toBe("read");
    expect(workOf("search")).toBe("search");
    expect(workOf("webFetch")).toBe("web");
    expect(workOf("webSearch")).toBe("web");
    expect(workOf("fileChange")).toBe("edit");
    expect(workOf("mcpToolCall")).toBe("tool");
    expect(workOf("toolCall")).toBe("tool");
    expect(workOf(null)).toBe("tool");
  });
});

describe("chooseMood", () => {
  it("is idle when nothing is going on", () => {
    const memory = newMemory(input());
    expect(chooseMood(input(), memory, 1_000)).toEqual({ mood: "idle", work: null });
  });

  it("works with the prop for what it is doing", () => {
    const busy = input({ busy: true, inFlight: true, kind: "fileRead" });
    expect(chooseMood(busy, newMemory(busy), 1_000)).toEqual({ mood: "working", work: "read" });
  });

  it("thinks while it is busy but between calls or reasoning", () => {
    const between = input({ busy: true, inFlight: false, kind: "commandExecution" });
    expect(chooseMood(between, newMemory(between), 1_000).mood).toBe("thinking");
    const reasoning = input({ busy: true, inFlight: true, kind: "reasoning" });
    expect(chooseMood(reasoning, newMemory(reasoning), 1_000).mood).toBe("thinking");
  });

  it("talks while its words are being revealed, even over a tool call", () => {
    const talking = input({ busy: true, speaking: true, inFlight: true, kind: "commandExecution" });
    expect(chooseMood(talking, newMemory(talking), 1_000).mood).toBe("talking");
  });

  it("needs you above everything else", () => {
    const needs = input({ busy: true, waiting: true, speaking: true, failed: true });
    expect(chooseMood(needs, newMemory(needs), 1_000).mood).toBe("needs");
  });

  it("shows failure while the thread is in error", () => {
    const failed = input({ failed: true });
    expect(chooseMood(failed, newMemory(failed), 1_000).mood).toBe("failed");
  });

  it("celebrates for a moment after work stops, then settles", () => {
    const memory = newMemory(input({ busy: true }));
    chooseMood(input({ busy: true }), memory, 1_000);
    expect(chooseMood(input(), memory, 2_000).mood).toBe("done");
    expect(chooseMood(input(), memory, 2_000 + AFTERGLOW_MS - 1).mood).toBe("done");
    expect(chooseMood(input(), memory, 2_000 + AFTERGLOW_MS).mood).toBe("idle");
  });

  it("does not celebrate a lane that was already quiet when it appeared", () => {
    const memory = newMemory(input());
    expect(chooseMood(input(), memory, 5_000).mood).toBe("idle");
  });

  it("holds its celebration through the typing of the closing words", () => {
    // Busy ends while the bubble is still typing: talk first, celebrate after.
    const memory = newMemory(input({ busy: true }));
    chooseMood(input({ busy: true, speaking: true }), memory, 1_000);
    expect(chooseMood(input({ speaking: true }), memory, 1_500).mood).toBe("talking");
    expect(chooseMood(input(), memory, 2_000).mood).toBe("done");
  });

  it("sulks rather than celebrates when it stops because it failed", () => {
    const memory = newMemory(input({ busy: true }));
    chooseMood(input({ busy: true }), memory, 1_000);
    // The failure clears (status moves on) but it ended badly.
    expect(chooseMood(input({ failed: true }), memory, 2_000).mood).toBe("failed");
    const memory2 = newMemory(input({ busy: true }));
    chooseMood(input({ busy: true }), memory2, 1_000);
    chooseMood(input({ failed: true }), memory2, 2_000);
    expect(chooseMood(input(), memory2, 2_500).mood).toBe("failed");
    expect(chooseMood(input(), memory2, 2_000 + AFTERGLOW_MS + 1).mood).toBe("idle");
  });

  it("nods off after a long quiet, and wakes when work starts", () => {
    const quiet = input({ quietMs: SLEEP_AFTER_MS + 1 });
    const memory = newMemory(quiet);
    expect(chooseMood(quiet, memory, 1_000).mood).toBe("sleeping");
    expect(chooseMood({ ...quiet, busy: true, quietMs: 0 }, memory, 2_000).mood).toBe("thinking");
  });
});
