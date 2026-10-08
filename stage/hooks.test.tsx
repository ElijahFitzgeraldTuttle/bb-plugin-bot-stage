// @vitest-environment jsdom
// A lane that leaves must be gone a moment later, however often the list is
// rebuilt meanwhile: the stage rebuilds its lanes every second to age them,
// and a lane whose exit timer was cancelled by that stayed on as an invisible
// ghost, holding a lane's height open in the middle of the list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useExitList } from "./hooks";

const EXIT_MS = 420;
const item = (id: string, age = 0) => ({ id, age });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function mount(initial: Array<{ id: string; age: number }>) {
  return renderHook(({ items }) => useExitList(items, EXIT_MS), { initialProps: { items: initial } });
}

const ids = (shown: Array<{ item: { id: string }; leaving: boolean }>) =>
  shown.map((entry) => `${entry.item.id}${entry.leaving ? "~" : ""}`);

describe("useExitList", () => {
  it("keeps a departing lane flagged for the exit, then drops it", () => {
    const view = mount([item("a"), item("b")]);
    view.rerender({ items: [item("b")] });
    expect(ids(view.result.current)).toEqual(["a~", "b"]);
    act(() => void vi.advanceTimersByTime(EXIT_MS + 1));
    expect(ids(view.result.current)).toEqual(["b"]);
  });

  it("drops a departing lane even when the list is rebuilt during its exit", () => {
    const view = mount([item("a"), item("b")]);
    view.rerender({ items: [item("b")] });
    // The one-second age tick lands inside the exit window.
    act(() => void vi.advanceTimersByTime(200));
    view.rerender({ items: [item("b", 1)] });
    act(() => void vi.advanceTimersByTime(EXIT_MS));
    expect(ids(view.result.current)).toEqual(["b"]);
  });

  it("drops it however many rebuilds land inside the exit", () => {
    const view = mount([item("a"), item("b")]);
    view.rerender({ items: [item("b")] });
    for (let tick = 1; tick <= 9; tick++) {
      act(() => void vi.advanceTimersByTime(50));
      view.rerender({ items: [item("b", tick)] });
    }
    expect(ids(view.result.current)).toEqual(["b"]);
  });

  it("brings a lane back when it returns before its exit ends", () => {
    const view = mount([item("a"), item("b")]);
    view.rerender({ items: [item("b")] });
    act(() => void vi.advanceTimersByTime(100));
    view.rerender({ items: [item("a"), item("b")] });
    expect(ids(view.result.current)).toEqual(["a", "b"]);
    act(() => void vi.advanceTimersByTime(EXIT_MS * 2));
    expect(ids(view.result.current)).toEqual(["a", "b"]);
  });

  it("gives each of several departing lanes its own exit", () => {
    const view = mount([item("a"), item("b"), item("c")]);
    view.rerender({ items: [item("c")] });
    act(() => void vi.advanceTimersByTime(300));
    view.rerender({ items: [item("c", 1)] });
    expect(ids(view.result.current)).toEqual(["a~", "b~", "c"]);
    act(() => void vi.advanceTimersByTime(EXIT_MS));
    expect(ids(view.result.current)).toEqual(["c"]);
  });
});
