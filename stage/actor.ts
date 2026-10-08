// bb-plugin-bot-stage — one bot on one small canvas.
//
// An Actor owns a soft body (the companion renderer's liquid pixel block), the
// timeline of what that bot is doing, and the little reactions that make it
// feel alive: a hop when it finishes, a hop to get your attention, a gaze that
// follows your pointer, a drop-in entrance, a hop back to its spot after you
// have thrown it across the box. It draws only when something changed.
//
// It is deliberately not a React component. The stage renders a handful of
// these at 30–60 fps, and none of that belongs in React's render path: the
// component hands the actor its latest facts with `set`, and the actor reads
// them on its own clock.
import { SoftBody, type World } from "../vendor/softbody";
import {
  drawBody,
  drawDrops,
  drawFace,
  drawMini,
  restParticles,
  view,
  type Expression,
  type Mood,
} from "../vendor/sprites";
import type { Bot } from "../vendor/types";
import type { Pose } from "../lib/mood";
import { pointer, prefersStill } from "./engine";
import { FrameRecorder } from "./recorder";

/** Fixed physics step, however fast the screen refreshes. */
const STEP = 1 / 180;
/** Particle spacing, in px at full size. About 35 particles make a body. */
const SPACING = 11.5;
const IDLE_EXPRESSIONS: Expression[] = ["lookL", "lookR", "lookUp", "wide", "narrow", "happy", "dot"];

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** How runny each kind of bot is. All of them are liquid in motion. */
function tuningFor(bot: Bot, k: number) {
  const shape = bot.avatar.shape;
  return {
    gravity: 1400 * k,
    softness: shape === "cloud" ? 0.85 : shape === "triangle" ? 0.55 : 0.7,
    firmness: 0.3,
    stretch: 0.5,
    friction: 0.5,
    bounce: 0,
    tearDistance: 30 * k,
  };
}

export interface ActorOptions {
  canvas: HTMLCanvasElement;
  bot: Bot;
  /** Body scale: 1 is the full-size companion in a chat. */
  k: number;
  /** Where along the canvas the body stands, 0..1, leaving room for props. */
  anchor: number;
  /** Wait this long before dropping in, so a stage fills in one by one. */
  spawnDelay: number;
}

/** What the actor needs to know, refreshed whenever the lane re-renders. */
export interface ActorInput {
  /** What the thread is doing, decided by the lane. */
  pose: Pose;
  /** How long since anything happened. */
  quietMs: number;
  /** Share of the context window spent, 0..1, or null when unreported. */
  context: number | null;
  /** Subagents at work under this thread, drawn as little friends. */
  helpers: number;
}

export class Actor {
  readonly bot: Bot;
  /** Set by the lane when it scrolls out of view. A hidden bot costs nothing. */
  visible = true;
  hovered = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly k: number;
  private readonly anchor: number;
  private readonly rest: { x: number; y: number }[];
  private readonly spacing: number;
  private readonly restBottom: number;
  private readonly bornAt = performance.now();
  private readonly spawnDelay: number;
  private readonly rec = new FrameRecorder();

  private input: ActorInput | null = null;
  private body: SoftBody | null = null;
  private world: World = { bounds: { left: 0, top: -400, right: 1, bottom: 1 }, solids: [] };
  private width = 0;
  private height = 0;
  private dpr = 1;
  private home = { x: 0, y: 0 };
  private alive = true;
  private shown: (number | string)[] = [];
  private drawnAt = 0;
  private tickedAt = 0;
  private lastNow = 0;
  private acc = 0;
  private lively = true;
  private rect: DOMRect | null = null;
  private rectAt = -Infinity;

  private mood: Mood = "idle";
  private prevMood: Mood = "idle";
  private expr: Expression = "base";
  private exprUntil = 0;
  private nextExpr = performance.now() + 3000 + Math.random() * 4000;
  private nextBlink = performance.now() + 2000 + Math.random() * 4000;
  private blinkUntil = 0;
  private nextHop = 0;
  private nextHome = 0;
  private wakeUntil = 0;
  private greetUntil = 0;
  private lastActiveAt = performance.now();
  private grab: { x: number; y: number; t: number; moved: boolean } | null = null;
  private settledFrames = 0;
  private still = false;

  constructor(options: ActorOptions) {
    this.canvas = options.canvas;
    const ctx = options.canvas.getContext("2d");
    if (ctx === null) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
    this.bot = options.bot;
    this.k = options.k;
    this.anchor = options.anchor;
    this.spawnDelay = options.spawnDelay;
    this.spacing = SPACING * options.k;
    this.rest = restParticles(options.bot.avatar.shape, this.spacing, options.k);
    const mean = this.rest.reduce((sum, p) => sum + p.y, 0) / Math.max(1, this.rest.length);
    this.restBottom = Math.max(...this.rest.map((p) => p.y)) - mean;
    this.still = prefersStill() || options.bot.avatar.motion === "still";
  }

  /** The lane's latest facts. Cheap: it only stores them. */
  set(input: ActorInput): void {
    this.input = input;
  }

  /** Match the canvas to its box, in CSS pixels. Call on mount and on resize. */
  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.dpr = dpr;
    // Keep physics in the original box, with transparent room for jumps,
    // work emojis and helpers outside it. Padding must not enlarge the bot.
    this.canvas.width = Math.round((this.width + 128) * dpr);
    // Nothing is drawn below the floor. Bottom padding would create a phantom
    // scrollbar because transparent canvas pixels still count as overflow.
    this.canvas.height = Math.round((this.height + 64) * dpr);
    this.canvas.style.width = `${this.width + 128}px`;
    this.canvas.style.height = `${this.height + 64}px`;
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "-64px";
    this.canvas.style.top = "-64px";
    const floor = this.height - 3;
    this.world = {
      // Open above the canvas so a bot can fall in from out of frame.
      bounds: { left: 3, top: -this.height * 2, right: this.width - 3, bottom: floor },
      solids: [],
    };
    this.home = { x: this.width * this.anchor, y: floor - this.restBottom - 1 };
    this.shown = [];
    if (this.body !== null) this.respawn(false);
  }

  private respawn(drop: boolean): void {
    const at = this.still || !drop
      ? { x: this.home.x, y: this.home.y }
      : { x: this.home.x, y: -this.restBottom - 24 * this.k };
    this.body = new SoftBody(this.rest, at, this.spacing, tuningFor(this.bot, this.k));
    this.acc = 0;
    this.settledFrames = 0;
  }

  /* -------------------------- input -------------------------- */

  /** Pick the bot up at (x, y), canvas-local. Returns false if the hand missed. */
  pointerDown(x: number, y: number, now = performance.now()): boolean {
    this.grab = { x, y, t: now, moved: false };
    if (this.body === null) return false;
    const hit = this.body.grab(x, y);
    if (!hit) this.grab.moved = false;
    return hit;
  }

  pointerMove(x: number, y: number): void {
    const grab = this.grab;
    if (grab === null || this.body === null) return;
    if (Math.hypot(x - grab.x, y - grab.y) > 5) grab.moved = true;
    const b = this.world.bounds;
    this.body.moveHand(clamp(x, b.left, b.right), clamp(y, 6, b.bottom));
  }

  /** Let go. Returns true if that was a click rather than a pick-up. */
  pointerUp(now = performance.now()): boolean {
    const grab = this.grab;
    this.grab = null;
    if (this.body?.held) this.body.release();
    if (grab === null) return false;
    const click = !grab.moved && now - grab.t < 400;
    if (click) this.greetUntil = now + 900;
    return click;
  }

  /** A small hello: used when a lane is opened or focused. */
  greet(now = performance.now()): void {
    this.greetUntil = now + 900;
    if (this.body?.grounded) this.body.impulse(0, -200 * this.k);
  }

  dispose(): void {
    this.alive = false;
    this.body = null;
    this.grab = null;
  }

  /* --------------------------- loop --------------------------- */

  /** One engine frame. `skipResting` lets the engine brake quiet bots. */
  tick(now: number, skipResting = false): void {
    if (!this.alive || !this.visible || this.input === null) return;
    if (this.width === 0) return;
    if (this.body === null) {
      if (now - this.bornAt < this.spawnDelay) return;
      this.respawn(true);
      if (this.body === null) return;
    }
    const body = this.body;
    const interval = this.lively ? 15 : 32;
    if (now - this.tickedAt < interval - 2) return;
    if (skipResting && !this.lively) return;
    this.tickedAt = now;
    const dt = Math.min(0.05, (now - (this.lastNow || now)) / 1000);
    this.lastNow = now;
    const input = this.input;

    // Mood: what the thread is doing, then what you are doing to the bot.
    const pose = input.pose;
    const mood: Mood = body.held
      ? "held"
      : pose.mood === "idle" && (this.hovered || now < this.greetUntil)
        ? "watching"
        : pose.mood;
    if (mood !== "idle" && mood !== "sleeping") this.lastActiveAt = now;
    if (this.prevMood === "sleeping" && mood !== "sleeping") this.wakeUntil = now + 700;
    if (mood !== this.prevMood) {
      if (!this.still) {
        if (mood === "done") body.impulse(0, -340 * this.k);
        else if (mood === "needs") body.impulse(0, -280 * this.k);
        else if (mood === "failed") body.impulse((Math.random() - 0.5) * 120 * this.k, -80 * this.k);
      }
      this.prevMood = mood;
      this.mood = mood;
    }
    // Needs you: keep hopping until someone answers.
    if (!this.still && mood === "needs" && now >= this.nextHop && body.grounded) {
      body.impulse(0, -240 * this.k);
      this.nextHop = now + 1600;
    }
    // Hop back to its spot after being thrown about.
    if (!this.still && !body.held && body.grounded && now >= this.nextHome) {
      const dx = this.home.x - body.center.x;
      if (Math.abs(dx) > 10 * this.k) {
        body.impulse(clamp(dx * 3.2, -150 * this.k, 150 * this.k), -230 * this.k);
        this.nextHome = now + 700;
      }
    }

    // Talking: two beating waves give a syllable rhythm to the mouth.
    const talk = mood === "talking" ? Math.max(0, Math.sin(now / 85) * 0.6 + Math.sin(now / 211) * 0.5 + 0.15) : 0;
    const breath = Math.sin(now / 950);
    body.restScale = this.still
      ? 1
      : 1 +
        (mood === "idle" || mood === "watching" ? 0.01 : 0.016) * breath +
        Math.min(1, talk) * 0.05 +
        (mood === "working" ? 0.018 * Math.sin(now / 130) : 0);
    if (!this.still) {
      if (mood === "failed") body.restScale *= 0.94;
      else if (mood === "sleeping") body.restScale = 1 + 0.025 * Math.sin(now / 1500);
      else if (now < this.wakeUntil) body.restScale += 0.05;
      if (now < this.greetUntil) body.restScale += 0.06;
    }

    // Idle expressions: a glance, a squint, a smile, and blinks at random.
    if (now > this.nextBlink) {
      this.blinkUntil = now + 140;
      this.nextBlink = now + 2500 + Math.random() * 5500;
    }
    if (mood !== "idle") {
      this.expr = "base";
      this.nextExpr = Math.max(this.nextExpr, now + 2500);
    } else if (this.expr !== "base" && now > this.exprUntil) {
      this.expr = "base";
      this.nextExpr = now + 4000 + Math.random() * 6000;
    } else if (this.expr === "base" && now > this.nextExpr && !this.still) {
      this.expr = IDLE_EXPRESSIONS[Math.floor(Math.random() * IDLE_EXPRESSIONS.length)] as Expression;
      this.exprUntil = now + 1200 + Math.random() * 2200;
    }
    if (now < this.greetUntil) this.expr = "happy";
    if (now < this.wakeUntil) this.expr = "wide";

    // Physics at a fixed step. A bot that has settled and is still stops
    // costing anything until something disturbs it.
    if (!(this.still && this.settledFrames > 120)) {
      this.acc = Math.min(this.acc + dt, STEP * 8);
      let stepped = 0;
      while (this.acc >= STEP) {
        body.step(STEP, this.world);
        this.acc -= STEP;
        stepped += 1;
      }
      if (stepped > 0) {
        const v = body.velocity();
        this.settledFrames = body.grounded && Math.hypot(v.vx, v.vy) < 12 ? this.settledFrames + 1 : 0;
      }
    }
    if (this.still) body.drops.length = 0;

    this.lively =
      body.held ||
      !body.grounded ||
      body.drops.length > 0 ||
      mood === "talking" ||
      mood === "working" ||
      mood === "needs" ||
      mood === "done" ||
      mood === "failed" ||
      now < this.greetUntil ||
      now < this.wakeUntil ||
      (input.helpers > 0 && mood !== "sleeping");

    if (now - this.drawnAt < (this.lively ? 15 : 32) - 2) return;
    this.drawnAt = now;
    this.paint(body, input, mood, pose.work, talk, now);
  }

  private gazeTarget(now: number): { x: number; y: number } | null {
    if (!pointer.active) return null;
    if (now - this.rectAt > 250) {
      this.rect = this.canvas.getBoundingClientRect();
      this.rectAt = now;
    }
    const rect = this.rect;
    return rect === null ? null : { x: pointer.x - rect.left - 64, y: pointer.y - rect.top - 64 };
  }

  private paint(
    body: SoftBody,
    input: ActorInput,
    mood: Mood,
    work: Pose["work"],
    talk: number,
    now: number,
  ): void {
    const rec = this.rec;
    const r = rec as unknown as CanvasRenderingContext2D;
    const color = this.bot.avatar.color;
    view.k = this.k;
    rec.reset(this.dpr);

    // A flat pixel shadow that shrinks as the bot leaves the floor.
    const box = body.bbox();
    const floor = this.world.bounds.bottom;
    const gap = Math.max(0, floor - box.bottom);
    const shrink = 1 - Math.min(0.55, gap / (70 * this.k));
    const shadowW = (box.right - box.left) * 0.86 * shrink;
    if (shadowW > 2) {
      rec.fillStyle = `rgba(0, 0, 0, ${0.2 * shrink})`;
      rec.fillRect(body.center.x - shadowW / 2, floor - 2 * this.k, shadowW, Math.max(2, 3.5 * this.k));
    }

    drawDrops(r, body.drops, color);
    drawBody(r, body, color);
    drawFace(r, this.bot, body, {
      mood,
      expr: now < this.blinkUntil && mood !== "held" ? "blink" : this.expr,
      gaze: mood === "idle" || mood === "watching" || mood === "talking" ? this.gazeTarget(now) : null,
      talk: Math.min(1, talk),
      now,
      work: mood === "working" ? work : null,
      stress: 0,
      context: input.context,
      waking: now < this.wakeUntil,
    });
    // Subagents at work stand beside it as little copies.
    const helpers = Math.min(3, input.helpers);
    for (let index = 0; index < helpers; index += 1) {
      // Half the size of the bot itself: three of them still fit beside it.
      drawMini(r, body.center.x + (46 + index * 25) * this.k, floor - 1, this.bot.avatar.shape, color, this.k * 0.55, now, index * 2.3, true);
    }

    if (rec.same(this.shown)) return;
    this.shown = rec.ops.slice();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 64 * this.dpr, 64 * this.dpr);
    ctx.imageSmoothingEnabled = false;
    rec.replay(ctx);
  }

  /** For tests and the bench: where the body is, or null before it drops in. */
  get position(): { x: number; y: number } | null {
    return this.body === null ? null : this.body.center;
  }

  get currentMood(): Mood {
    return this.mood;
  }
}
