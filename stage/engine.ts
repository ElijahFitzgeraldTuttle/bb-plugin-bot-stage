// bb-plugin-bot-stage — one animation loop for every bot on the stage.
//
// Each lane has its own small canvas, but there is a single requestAnimationFrame
// for all of them, one pointer listener for the eyes to follow, and a simple
// brake: if the stage is costing too much per frame, bots that are only
// breathing skip every other frame until it is not.
import type { Actor } from "./actor";

/** The pointer in client coordinates, for eyes that follow it. */
export const pointer = { x: -1e4, y: -1e4, active: false };

const actors = new Set<Actor>();
let raf = 0;
let installed = false;
let frame = 0;
/** Smoothed ms spent ticking actors, per frame. */
let spent = 0;
/** Above this, resting bots are throttled; below half of it they are not. */
const BUDGET_MS = 9;
let throttled = false;

function onPointerMove(event: PointerEvent): void {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.active = true;
}

function onPointerLeave(): void {
  pointer.active = false;
}

function loop(): void {
  raf = requestAnimationFrame(loop);
  if (document.hidden) return;
  frame += 1;
  // One clock for everything the actors do: they schedule against
  // performance.now(), so that is what they are handed.
  const now = performance.now();
  const started = now;
  const skipResting = throttled && frame % 2 === 0;
  for (const actor of actors) actor.tick(now, skipResting);
  spent = spent * 0.9 + (performance.now() - started) * 0.1;
  if (!throttled && spent > BUDGET_MS) throttled = true;
  else if (throttled && spent < BUDGET_MS / 2) throttled = false;
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
}

/** Start ticking an actor. Returns the function that stops it. */
export function register(actor: Actor): () => void {
  install();
  actors.add(actor);
  if (raf === 0) raf = requestAnimationFrame(loop);
  return () => {
    actors.delete(actor);
    if (actors.size === 0 && raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** For tests and the bench: how many bots are being animated. */
export function liveActors(): number {
  return actors.size;
}

/** Is the stage currently braking to save power? */
export function isThrottled(): boolean {
  return throttled;
}

/** Calm mode, or the OS asking for less motion: bots hold still. */
export function prefersStill(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
    document.documentElement.hasAttribute("data-calm") ||
    document.documentElement.hasAttribute("data-bb-resting")
  );
}
