// bb-plugin-bot-stage — the small hooks the stage's lanes share.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Said } from "../lib/fleet";
import { AFTERGLOW_MS, chooseMood, newMemory, type MoodInput, type MoodMemory, type Pose } from "../lib/mood";
import {
  characterBudget,
  headOf,
  plainSegments,
  plainText,
  sliceSegments,
  Typewriter,
  type Seg,
} from "../lib/speech";

/** The wall clock, ticking once a second while `active`, so "12s" keeps counting. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** An element's content width, kept current. Zero until it has a layout. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setWidth((current) => {
      const next = Math.round(element.clientWidth);
      return next === current ? current : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * What a lane's bot is doing, from the thread alone. Computed while rendering,
 * so the lane's label and colours never wait on a canvas, plus a timer to look
 * again the moment a celebration (or a sulk) is over.
 */
export function usePose(input: MoodInput): Pose {
  const memory = useRef<MoodMemory | null>(null);
  memory.current ??= newMemory(input);
  const [, again] = useReducer((count: number) => count + 1, 0);
  const pose = chooseMood(input, memory.current, performance.now());
  const endedAt = memory.current.endedAt;
  const afterglow = (pose.mood === "done" || pose.mood === "failed") && !input.failed;
  useEffect(() => {
    if (!afterglow) return;
    const left = AFTERGLOW_MS - (performance.now() - endedAt);
    const timer = setTimeout(again, Math.max(40, left + 40));
    return () => clearTimeout(timer);
  }, [afterglow, endedAt]);
  return pose;
}

export interface Speech {
  /** What is visible right now, as runs of text. */
  segments: Seg[];
  /** The words are still being revealed. */
  typing: boolean;
  /** The message was cut to fit the bubble. */
  cut: boolean;
  /** The id of the message being shown, for keying the bubble's entrance. */
  id: string;
}

/**
 * Turns the agent's latest message into what its bubble shows, one reveal at
 * a time. The first message a lane ever shows appears at once (it was said
 * before you looked); every one after that is typed out.
 */
export function useSpeech(said: Said | null, budget: number): Speech {
  const typewriter = useRef<Typewriter | null>(null);
  typewriter.current ??= new Typewriter();
  const first = useRef(true);
  const segments = useMemo(() => plainSegments(said?.text ?? ""), [said?.text]);
  const head = useMemo(() => headOf(segments, budget), [segments, budget]);
  const plain = useMemo(() => plainText(head.segs), [head.segs]);
  const id = said?.id ?? "";
  const [count, setCount] = useState(0);
  const [typing, setTyping] = useState(false);

  useLayoutEffect(() => {
    const tw = typewriter.current as Typewriter;
    // A message that is still being written is worth watching even on the
    // first look; one that is finished was said before we arrived.
    const instant = first.current && said?.done !== false;
    first.current = false;
    tw.setTarget(id, plain, instant);
    setCount(tw.visible);
    setTyping(tw.typing);
  }, [id, plain, said?.done]);

  useEffect(() => {
    const tw = typewriter.current as Typewriter;
    if (!typing) return;
    let raf = 0;
    let last = performance.now();
    // Time comes from performance.now(), not the frame timestamp: the two are
    // on one clock in a browser, but nothing here should depend on that.
    const loop = () => {
      const now = performance.now();
      const visible = tw.step(now - last);
      last = now;
      setCount(visible);
      if (tw.typing) raf = requestAnimationFrame(loop);
      else setTyping(false);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [typing, id, plain]);

  const shown = useMemo(() => sliceSegments(head.segs, count), [head.segs, count]);
  return { segments: shown, typing, cut: head.cut, id };
}

export interface Leaving<T> {
  item: T;
  leaving: boolean;
}

/**
 * Keeps an item on the list for a moment after it leaves, flagged, so its
 * lane can animate out instead of vanishing. Items that come back before the
 * exit finishes are simply un-flagged.
 *
 * `items` is a new array on every tick of the stage's clock, so nothing here
 * may depend on it staying put during an exit: each departed item carries its
 * own expiry, and a timer that follows the departed set (not `items`) sweeps
 * them. A timer owned by the `items` effect was cleared by the next tick, and
 * the lane stayed on as an invisible ghost holding its height open.
 */
export function useExitList<T extends { id: string }>(items: readonly T[], exitMs: number): Leaving<T>[] {
  const [gone, setGone] = useState<Map<string, { item: T; index: number; until: number }>>(() => new Map());
  const previous = useRef<readonly T[]>(items);

  useEffect(() => {
    const now = new Set(items.map((item) => item.id));
    const left: Array<{ item: T; index: number }> = [];
    previous.current.forEach((item, index) => {
      if (!now.has(item.id)) left.push({ item, index });
    });
    previous.current = items;
    if (left.length === 0 && gone.size === 0) return;
    const until = Date.now() + exitMs;
    setGone((current) => {
      const next = new Map(current);
      for (const id of now) next.delete(id);
      for (const entry of left) if (!next.has(entry.item.id)) next.set(entry.item.id, { ...entry, until });
      return next.size === current.size && [...next.keys()].every((id) => current.has(id)) ? current : next;
    });
  // `gone` is read only to skip no-op updates; the effect is driven by `items`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, exitMs]);

  // One timer, for the soonest exit. It removes exactly the entries that were
  // due when it was set, so a clock that fires a hair early cannot strand one.
  useEffect(() => {
    if (gone.size === 0) return;
    const soonest = Math.min(...[...gone.values()].map((entry) => entry.until));
    const timer = setTimeout(() => {
      setGone((current) => {
        const next = new Map(current);
        for (const [id, entry] of current) if (entry.until <= soonest) next.delete(id);
        return next;
      });
    }, Math.max(0, soonest - Date.now()));
    return () => clearTimeout(timer);
  }, [gone]);

  return useMemo(() => {
    const out: Leaving<T>[] = items.map((item) => ({ item, leaving: false }));
    const present = new Set(items.map((item) => item.id));
    const ghosts = [...gone.values()].filter((entry) => !present.has(entry.item.id)).sort((a, b) => a.index - b.index);
    for (const ghost of ghosts) out.splice(Math.min(ghost.index, out.length), 0, { item: ghost.item, leaving: true });
    return out;
  }, [items, gone]);
}

/**
 * FLIP: when lanes change places, slide each from where it was to where it is,
 * instead of snapping. `key` changes whenever the order might have.
 */
export function useFlip(listRef: RefObject<HTMLElement | null>, key: string, enabled = true): void {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const next = new Map<string, number>();
    const moved: Array<{ element: HTMLElement; dy: number }> = [];
    for (const child of Array.from(list.children)) {
      const element = child as HTMLElement;
      const id = element.dataset.id;
      if (id === undefined) continue;
      const top = element.offsetTop;
      next.set(id, top);
      const before = tops.current.get(id);
      if (enabled && before !== undefined && Math.abs(before - top) > 1 && element.dataset.leaving !== "true") {
        moved.push({ element, dy: before - top });
      }
    }
    tops.current = next;
    for (const { element, dy } of moved) {
      element.animate?.(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: 420, easing: "cubic-bezier(.2,.9,.25,1.08)" },
      );
    }
  }, [listRef, key, enabled]);
}

/** A stable callback that always calls the latest function. */
export function useLatest<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...args: never[]) => ref.current(...args)) as T, []);
}

/** Budget helper so Lane and tests agree on how a bubble's room is measured. */
export function bubbleBudget(widthPx: number, fontPx: number, lines: number): number {
  // Not measured yet (or not measurable): do not cut anything. The bubble's
  // own line clamp keeps the layout honest until there is a width.
  return widthPx <= 0 ? Number.POSITIVE_INFINITY : characterBudget(widthPx, fontPx, lines);
}
