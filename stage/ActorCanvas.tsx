// bb-plugin-bot-stage — the React end of an Actor: a canvas, its lifecycle,
// and the pointer events that let you pick the bot up.
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Bot } from "../vendor/types";
import { Actor, type ActorInput } from "./actor";
import { register } from "./engine";

export interface ActorCanvasProps {
  bot: Bot;
  k: number;
  anchor: number;
  width: number;
  height: number;
  spawnDelay: number;
  input: ActorInput;
  /** Spoken description for assistive technology. */
  label: string;
  /** A tap rather than a pick-up. */
  onActivate: (modified: boolean) => void;
}

export function ActorCanvas(props: ActorCanvasProps) {
  const { bot, k, anchor, width, height, spawnDelay } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const actor = useRef<Actor | null>(null);
  // The newest facts, kept where a freshly built actor can read them at once:
  // waiting for the next render to hand them over left a new lane empty for a
  // second, which is exactly when someone is looking.
  const latest = useRef(props.input);
  latest.current = props.input;

  // A bot is rebuilt only when what it looks like changes, not on every frame
  // of data: its body is a physics simulation with a memory.
  const look = `${bot.id}|${bot.avatar.shape}|${bot.avatar.color}|${bot.avatar.motion}|${bot.name}`;
  useEffect(() => {
    const element = canvas.current;
    const box = host.current;
    if (element === null || box === null) return;
    let made: Actor;
    try {
      made = new Actor({
        canvas: element,
        bot,
        k,
        anchor,
        spawnDelay,
      });
    } catch {
      return; // no 2d canvas: the lane still reads fine without its bot
    }
    made.resize(width, height, window.devicePixelRatio || 1);
    made.set(latest.current);
    actor.current = made;
    const stop = register(made);
    // A lane scrolled out of view should cost nothing.
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            for (const entry of entries) made.visible = entry.isIntersecting;
          });
    observer?.observe(box);
    return () => {
      observer?.disconnect();
      stop();
      made.dispose();
      actor.current = null;
    };
    // `look` stands for the parts of `bot` that change how it is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look, k, anchor, width, height]);

  // The lane's latest facts, handed over on every render. Cheap by design.
  actor.current?.set(props.input);

  const local = (event: ReactPointerEvent) => {
    const rect = host.current?.getBoundingClientRect();
    return rect === undefined ? { x: 0, y: 0 } : { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <div
      ref={host}
      className="bst-actor"
      role="img"
      aria-label={props.label}
      style={{ width, height, touchAction: "none" }}
      onPointerEnter={() => {
        if (actor.current !== null) actor.current.hovered = true;
      }}
      onPointerLeave={() => {
        if (actor.current !== null) actor.current.hovered = false;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const point = local(event);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        actor.current?.pointerDown(point.x, point.y);
      }}
      onPointerMove={(event) => {
        const point = local(event);
        actor.current?.pointerMove(point.x, point.y);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        const click = actor.current?.pointerUp() ?? true;
        if (click) props.onActivate(event.shiftKey || event.metaKey || event.ctrlKey);
      }}
      onPointerCancel={() => {
        actor.current?.pointerUp();
      }}
    >
      <canvas ref={canvas} />
    </div>
  );
}
