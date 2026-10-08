// A 2D soft body for one companion, plus the bits it sheds.
//
// The body is a cloud of particles sampled from the bot's silhouette. Each
// step they fall under gravity, collide with the world's solid rectangles,
// push apart, and are pulled back toward their rest shape by meshless shape
// matching (Müller et al. 2005): best-fit rotation plus a little linear
// stretch, so it can squash and stretch but always remembers its shape.
//
// It behaves like a thick liquid that remembers its shape: while it moves it
// is nearly all fluid (it splashes, smears and pours), and only once it slows
// to rest does it gather itself back into its true form. Surfaces soak up
// impacts instead of bouncing them back. Grabbed particles follow the hand through
// a soft spring, so the rest hangs, stretches and swings by itself; a throw is
// just the momentum the particles already have. Particles stretched far from
// their goal tear off small drops, which fall, splat onto whatever they hit,
// and crumble away.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface World {
  /** The box the body lives in (the chat pane). */
  bounds: Rect;
  /** Solid obstacles inside it (the composer). */
  solids: Rect[];
}

export interface Tuning {
  gravity: number; // px/s²
  softness: number; // 0..1, how gooey at rest
  firmness: number; // extra stiffness under fast strain
  stretch: number; // 0..1, how much linear (squash/stretch) deformation is allowed
  friction: number; // 0..1, tangential loss on contact
  bounce: number; // 0..1, normal restitution
  tearDistance: number; // px from goal before a drop tears off
}

export const DEFAULT_TUNING: Tuning = {
  gravity: 1500,
  softness: 0.75,
  firmness: 0.55,
  stretch: 0.35,
  friction: 0.35,
  bounce: 0.12,
  tearDistance: 26,
};

interface Particle {
  x: number;
  y: number;
  px: number; // predicted position
  py: number;
  vx: number;
  vy: number;
  qx: number; // rest offset from the rest centroid
  qy: number;
  gx: number; // last goal
  gy: number;
  grab: { ox: number; oy: number } | null;
  contact: boolean;
  sx: number; // this step's shape-memory correction (moves it, but adds no momentum)
  sy: number;
}

export interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number; // in cells
  age: number;
  life: number;
  stuck: boolean;
}

export interface Frame {
  cx: number;
  cy: number;
  /** Rotation and the deformation applied to the rest shape this frame. */
  a: number;
  b: number;
  c: number;
  d: number;
}

export class SoftBody {
  particles: Particle[] = [];
  /** Rest-neighbour pairs; drawn as strands so a stretched body stays in one piece. */
  links: [number, number][] = [];
  /** Which pixel cells were filled last frame (for steady, flicker-free edges). */
  cells = new Set<number>();
  private linkRest: number[] = [];
  drops: Drop[] = [];
  frame: Frame = { cx: 0, cy: 0, a: 1, b: 0, c: 0, d: 1 };
  spacing: number;
  tuning: Tuning;
  /** Breathing / idle scale of the rest shape (1 = rest). */
  restScale = 1;
  impact = 0; // decays; how hard the last hit was, 0..1
  private restTime = 0; // how long it has been resting and nearly still
  grounded = false;
  private hand: { x: number; y: number } | null = null;
  // Hanging: how far it has drooped (1 = rest length) and how that's moving.
  droop = 1;
  private droopV = 0;
  private heldFor = 0;
  private lastHand: { x: number; y: number; vx: number; vy: number } | null = null;
  private grabRest = { x: 0, y: 0 };
  private swing = 0; // pendulum angle from straight down, radians
  private swingV = 0;
  private restDown = { x: 0, y: 1 };
  private alongMax = 1;
  /** Where the face sits: the body's middle, or the hanging bulb. */
  faceAt = { x: 0, y: 0 };
  private Aqq: [number, number, number, number] = [1, 0, 0, 1];

  constructor(rest: { x: number; y: number }[], at: { x: number; y: number }, spacing: number, tuning: Tuning = DEFAULT_TUNING) {
    this.spacing = spacing;
    this.tuning = tuning;
    const mx = rest.reduce((s, p) => s + p.x, 0) / rest.length;
    const my = rest.reduce((s, p) => s + p.y, 0) / rest.length;
    let a = 0;
    let b = 0;
    let d = 0;
    for (const r of rest) {
      const qx = r.x - mx;
      const qy = r.y - my;
      a += qx * qx;
      b += qx * qy;
      d += qy * qy;
      this.particles.push({ x: at.x + qx, y: at.y + qy, px: 0, py: 0, vx: 0, vy: 0, qx, qy, gx: at.x + qx, gy: at.y + qy, grab: null, contact: false, sx: 0, sy: 0 });
    }
    for (let i = 0; i < this.particles.length; i++)
      for (let j = i + 1; j < this.particles.length; j++) {
        const a0 = this.particles[i];
        const b0 = this.particles[j];
        const rl = Math.hypot(a0.qx - b0.qx, a0.qy - b0.qy);
        if (rl < spacing * 1.35) {
          this.links.push([i, j]);
          this.linkRest.push(rl);
        }
      }
    // Inverse of Aqq = Σ q qᵀ, used for the linear (stretch) part.
    const det = a * d - b * b || 1;
    this.Aqq = [d / det, -b / det, -b / det, a / det];
    this.frame = { cx: at.x, cy: at.y, a: 1, b: 0, c: 0, d: 1 };
  }

  get center() {
    return { x: this.frame.cx, y: this.frame.cy };
  }

  bbox(pad = 0): Rect {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const p of this.particles) {
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
    return { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad };
  }

  /** Average velocity of the whole body. */
  velocity() {
    let vx = 0;
    let vy = 0;
    for (const p of this.particles) {
      vx += p.vx;
      vy += p.vy;
    }
    return { vx: vx / this.particles.length, vy: vy / this.particles.length };
  }

  /** Grab the particles near the hand. Returns false if the hand missed. */
  grab(x: number, y: number): boolean {
    const near = this.particles
      .map((p) => ({ p, d: Math.hypot(p.x - x, p.y - y) }))
      .sort((m, n) => m.d - n.d);
    if (!near.length || near[0].d > this.spacing * 3) return false;
    const radius = Math.max(near[0].d + this.spacing * 1.2, this.spacing * 1.6);
    for (const { p, d } of near) {
      if (d > radius) break;
      p.grab = { ox: (p.x - x) * 0.5, oy: (p.y - y) * 0.5 };
    }
    this.hand = { x, y };
    // Remember where on the rest shape it was grabbed, and which way "down
    // through the body" is from there, so it can hang from that point.
    const grabbed = this.particles.filter((p) => p.grab);
    this.grabRest = {
      x: grabbed.reduce((s, p) => s + p.qx, 0) / grabbed.length,
      y: grabbed.reduce((s, p) => s + p.qy, 0) / grabbed.length,
    };
    const dl = Math.hypot(this.grabRest.x, this.grabRest.y);
    this.restDown = dl > 4 ? { x: -this.grabRest.x / dl, y: -this.grabRest.y / dl } : { x: 0, y: 1 };
    this.alongMax = Math.max(
      this.spacing,
      ...this.particles.map((p) => (p.qx - this.grabRest.x) * this.restDown.x + (p.qy - this.grabRest.y) * this.restDown.y),
    );
    this.droop = 1;
    this.droopV = 0;
    this.heldFor = 0;
    this.lastHand = { x, y, vx: 0, vy: 0 };
    this.swing = 0;
    this.swingV = 0;
    return true;
  }

  moveHand(x: number, y: number) {
    if (this.hand) this.hand = { x, y };
  }

  release() {
    this.hand = null;
    for (const p of this.particles) p.grab = null;
  }

  get held() {
    return this.hand !== null;
  }

  /** A small push for every particle (a hop, a flinch). */
  impulse(vx: number, vy: number) {
    for (const p of this.particles) {
      p.vx += vx;
      p.vy += vy;
    }
  }

  step(h: number, world: World) {
    const t = this.tuning;
    const ps = this.particles;
    const n = ps.length;

    // 1. Predict.
    for (const p of ps) {
      p.sx = 0;
      p.sy = 0;
      if (!p.grab) p.vy += t.gravity * h;
      // Air drag; a bit more while hanging so swings die down like a real weight.
      const damp = Math.exp(-(p.contact ? 10 : this.hand ? 1.6 : 0.9) * h);
      p.vx *= damp;
      p.vy *= damp;
      p.px = p.x + p.vx * h;
      p.py = p.y + p.vy * h;
    }

    // 2. Hand: grabbed particles are pulled to the hand through a soft spring.
    if (this.hand) {
      for (const p of ps) {
        if (!p.grab) continue;
        const tx = this.hand.x + p.grab.ox;
        const ty = this.hand.y + p.grab.oy;
        p.px += (tx - p.px) * 0.55;
        p.py += (ty - p.py) * 0.55;
      }
    }

    // 3. Shape matching: best-fit rotation + some linear stretch.
    let cx = 0;
    let cy = 0;
    for (const p of ps) {
      cx += p.px;
      cy += p.py;
    }
    cx /= n;
    cy /= n;
    let a00 = 0;
    let a01 = 0;
    let a10 = 0;
    let a11 = 0;
    for (const p of ps) {
      const rx = p.px - cx;
      const ry = p.py - cy;
      a00 += rx * p.qx;
      a01 += rx * p.qy;
      a10 += ry * p.qx;
      a11 += ry * p.qy;
    }
    let angle = Math.atan2(a10 - a01, a00 + a11);
    // A righting reflex: resting on something and not held, it rolls itself
    // back upright, like a creature finding its feet.
    if (this.grounded && !this.hand) angle -= angle * Math.min(1, 5 * h);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Linear part A = Apq · Aqq⁻¹, normalised to keep area (det 1).
    const [i00, i01, i10, i11] = this.Aqq;
    let l00 = a00 * i00 + a01 * i10;
    let l01 = a00 * i01 + a01 * i11;
    let l10 = a10 * i00 + a11 * i10;
    let l11 = a10 * i01 + a11 * i11;
    const det = l00 * l11 - l01 * l10;
    if (det > 1e-6) {
      const k = 1 / Math.sqrt(det);
      l00 *= k;
      l01 *= k;
      l10 *= k;
      l11 *= k;
    } else {
      l00 = cos;
      l01 = -sin;
      l10 = sin;
      l11 = cos;
    }
    // Squash and stretch only while things are moving fast (or held), so a
    // body that has come to rest pulls itself back into shape.
    let speed = 0;
    for (const p of ps) speed += Math.hypot(p.vx, p.vy);
    speed /= n;
    const s = t.stretch * Math.min(1, Math.max(this.impact * 2, speed / 300, this.hand ? 0.9 : 0));
    const s2 = this.restScale;
    const m00 = (s * l00 + (1 - s) * cos) * s2;
    const m01 = (s * l01 - (1 - s) * sin) * s2;
    const m10 = (s * l10 + (1 - s) * sin) * s2;
    const m11 = (s * l11 + (1 - s) * cos) * s2;
    this.frame = { cx, cy, a: m00, b: m01, c: m10, d: m11 };

    if (this.hand) {
      this.hang(h);
    } else {
    this.faceAt = { x: cx, y: cy };
    // Shape memory only at rest: moving, it's nearly pure liquid; slowing
    // down, it gathers itself back into its form. A hit makes it splat.
    const rest = Math.max(0, 1 - speed / 260) ** 2;
    const pull = (0.012 + (1 - t.softness * 0.5) * 0.32 * rest) * (1 - this.impact * 0.8);
    for (const p of ps) {
      const gx = cx + m00 * p.qx + m01 * p.qy;
      const gy = cy + m10 * p.qx + m11 * p.qy;
      p.gx = gx;
      p.gy = gy;
      p.sx = (gx - p.px) * pull;
      p.sy = (gy - p.py) * pull;
      p.px += p.sx;
      p.py += p.sy;
    }
    }

    // 4a. Surface tension: neighbours can stretch a long way but never
    // separate, so the liquid pours and strings out in one piece.
    for (let iter = 0; iter < 4; iter++)
      for (let k = 0; k < this.links.length; k++) {
        const [i, j] = this.links[k];
        const p = ps[i];
        const q = ps[j];
        const dx = q.px - p.px;
        const dy = q.py - p.py;
        const d = Math.hypot(dx, dy);
        const max = this.linkRest[k] * (this.hand ? 3.2 : 2.2);
        if (d <= max || d < 1e-6) continue;
        const fix = (d - max) / d;
        const wp = p.grab ? 0 : 1;
        const wq = q.grab ? 0 : 1;
        if (wp + wq === 0) continue;
        const fp = fix * (wp / (wp + wq));
        const fq = fix * (wq / (wp + wq));
        p.px += dx * fp;
        p.py += dy * fp;
        q.px -= dx * fq;
        q.py -= dy * fq;
        // Counted as viscous: holding together shouldn't fling it around.
        p.sx += dx * fp;
        p.sy += dy * fp;
        q.sx -= dx * fq;
        q.sy -= dy * fq;
      }

    // 4b. Keep particles from piling onto each other.
    const minD = this.spacing * 0.8;
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      for (let j = i + 1; j < n; j++) {
        const q = ps[j];
        const dx = q.px - p.px;
        const dy = q.py - p.py;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) * 0.5;
        const ux = dx / d;
        const uy = dy / d;
        // Pressure inside the goo is viscous too: squashing it against a wall
        // spreads it out instead of springing it back.
        if (!p.grab) {
          p.px -= ux * push;
          p.py -= uy * push;
          p.sx -= ux * push;
          p.sy -= uy * push;
        }
        if (!q.grab) {
          q.px += ux * push;
          q.py += uy * push;
          q.sx += ux * push;
          q.sy += uy * push;
        }
      }
    }

    // 5. Collide with the world, then derive velocities.
    let hardest = 0;
    this.grounded = false;
    for (const p of ps) {
      const before = { x: p.px, y: p.py };
      p.contact = collide(p, world, this.spacing * 0.45);
      // Viscous: gathering back into shape moves the goo but mostly doesn't
      // turn into momentum, so it oozes back instead of springing back.
      const visc = this.hand ? 0.22 : 0.85 * Math.min(1, this.impact * 5 + speed / 350);
      const nvx = (p.px - p.x - p.sx * visc) / h;
      const nvy = (p.py - p.y - p.sy * visc) / h;
      if (p.contact) {
        // Friction on the tangent, a little bounce on the normal.
        const nx = p.px - before.x;
        const ny = p.py - before.y;
        const nl = Math.hypot(nx, ny) || 1;
        const ux = nx / nl;
        const uy = ny / nl;
        const vn = nvx * ux + nvy * uy;
        const tx = nvx - vn * ux;
        const ty = nvy - vn * uy;
        const incoming = Math.abs(p.vx * ux + p.vy * uy);
        hardest = Math.max(hardest, incoming);
        // Friction is a rate, so it feels the same at any step size.
        const keep = Math.exp(-t.friction * 30 * h);
        const out = Math.max(0, Math.min(vn, incoming * t.bounce));
        p.vx = tx * keep + ux * out;
        p.vy = ty * keep + uy * out;
        if (uy < -0.5) this.grounded = true;
      } else {
        p.vx = nvx;
        p.vy = nvy;
      }
      // Static friction: a body at rest on a surface stays planted.
      if (p.contact && speed < 25 && !this.hand) {
        p.vx *= 0.2;
        if (Math.abs(p.vy) < 30) p.vy *= 0.2;
      }
      p.x = p.px;
      p.y = p.py;
    }
    this.impact = Math.max(this.impact * Math.exp(-6 * h), Math.min(1, hardest / 1500));
    // Settling: resting on something and nearly still, goo goes dead still
    // rather than jiggling between gravity, the floor and its shape.
    if (!this.hand && this.restTime > 0.25) {
      const calm = Math.exp(-30 * h);
      for (const p of ps) {
        p.vx *= calm;
        p.vy *= calm;
      }
    }
    this.restTime = this.grounded && !this.hand && speed < 45 ? this.restTime + h : 0;

    // 6. Overstretched particles tear off a drop and snap partway home.
    for (const p of ps) {
      const gap = Math.hypot(p.x - p.gx, p.y - p.gy);
      if (gap > t.tearDistance && this.drops.length < 9 && Math.random() < h * 0.9) {
        this.drops.push({ x: p.x, y: p.y, vx: p.vx * 0.9, vy: p.vy * 0.9, size: Math.random() < 0.3 ? 2 : 1, age: 0, life: 4 + Math.random() * 4, stuck: false });
        p.x += (p.gx - p.x) * 0.3;
        p.y += (p.gy - p.y) * 0.3;
      }
    }
    if (hardest > 1000 && this.drops.length < 9 && Math.random() < 0.5) this.splash(hardest);

    // 7. Drops: fall, splat, stick, crumble.
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const q = this.drops[i];
      q.age += h;
      if (q.age >= q.life) {
        this.drops.splice(i, 1);
        continue;
      }
      if (q.stuck) {
        q.y += 4 * h; // a slow ooze down whatever it stuck to
        continue;
      }
      q.vy += t.gravity * h;
      const probe = { x: q.x, y: q.y, px: q.x + q.vx * h, py: q.y + q.vy * h } as Particle;
      if (collide(probe, world, 1)) {
        q.stuck = true;
        q.vx = 0;
        q.vy = 0;
        q.size = Math.min(3, q.size + 1); // splat flat
      }
      q.x = probe.px;
      q.y = probe.py;
    }
  }

  /**
   * Held like a water balloon: a thin neck stretches down from the hand into
   * a heavy bulb. The hang direction is wherever the body's mass actually is,
   * so it lags the hand and swings; the droop oozes longer the longer it's
   * held and springs like a bungee when the hand is yanked.
   */
  private hang(h: number) {
    const ps = this.particles;
    const hand = this.hand!;
    this.heldFor += h;
    // Bungee: yanking the hand up stretches it, the spring pulls it back.
    const prev = this.lastHand ?? { x: hand.x, y: hand.y, vx: 0, vy: 0 };
    // Pointer events arrive in jumps, so smooth the hand's motion before
    // reading an acceleration from it, and cap it to something an arm can do.
    const hvx = ((hand.x - prev.x) / h) * 0.12 + prev.vx * 0.88;
    const hvy = ((hand.y - prev.y) / h) * 0.12 + prev.vy * 0.88;
    const ax = Math.max(-9000, Math.min(9000, (hvx - prev.vx) / h));
    const accel = Math.max(-9000, Math.min(9000, (hvy - prev.vy) / h));
    this.lastHand = { x: hand.x, y: hand.y, vx: hvx, vy: hvy };

    // Which way it hangs: a pendulum from the hand. Gravity pulls it back to
    // straight down; the hand's acceleration (a moving pivot) swings it.
    const L = Math.max(30, this.alongMax * (0.6 + 0.7 * (this.droop - 1)));
    const g = this.tuning.gravity;
    this.swingV += (-((g + accel) * Math.sin(this.swing) + ax * Math.cos(this.swing)) / L - 2.2 * this.swingV) * h;
    // A true fulcrum: whip it hard enough and it goes right around the hand.
    this.swingV = Math.max(-28, Math.min(28, this.swingV));
    this.swing = this.swing + this.swingV * h;
    if (this.swing > Math.PI) this.swing -= 2 * Math.PI;
    if (this.swing < -Math.PI) this.swing += 2 * Math.PI;
    const dx = Math.sin(this.swing);
    const dy = Math.cos(this.swing);

    // The stretch is an elastic spring with the bulb's mass on the end: the
    // hand's acceleration along the hang pulls it long or lets it rebound,
    // and it bobs a few times (about 2 per second) before settling. Held a
    // while, its rest length oozes longer.
    const target = Math.min(2.6, 1.5 + this.heldFor * 1.2);
    const along = ax * dx + accel * dy; // pivot acceleration along the hang
    const K = 130; // ≈ 1.8 Hz
    const C = 2.8; // light damping: a few visible bobs
    this.droopV += (-K * (this.droop - target) - C * this.droopV - (along * 1.7) / this.alongMax) * h;
    this.droop = Math.max(0.75, Math.min(4.2, this.droop + this.droopV * h));
    // Perpendicular, matched to the rest shape's handedness.
    const px = -dy;
    const py = dx;
    const rd = this.restDown;
    const rpx = -rd.y;
    const rpy = rd.x;

    // Spinning flings the bulb outward (centrifugal stretch).
    const S = Math.min(3.1, this.droop + Math.min(0.6, (this.swingV * this.swingV * L) / (g * 4)));
    let fx = 0;
    let fy = 0;
    let fn = 0;
    for (const p of ps) {
      const relx = p.qx - this.grabRest.x;
      const rely = p.qy - this.grabRest.y;
      const along = relx * rd.x + rely * rd.y;
      const perp = relx * rpx + rely * rpy;
      const u = Math.max(0, Math.min(1, along / this.alongMax));
      // The neck (upper part) takes almost all of the stretch and pinches thin;
      // the bulb keeps its size and swells a touch, like a water balloon.
      const neck = smooth(0, 0.7, u);
      const length = this.alongMax * (u + (S - 1) * 0.92 * neck);
      // Aggressive taper: a single-block thread at the hand that only widens
      // well down the neck into a full, heavy bulb.
      const width = 0.04 + 1.12 * smooth(0.3, 0.95, u) ** 1.5;
      const gx = this.hand!.x + dx * length + px * perp * width;
      const gy = this.hand!.y + dy * length + py * perp * width;
      p.gx = gx;
      p.gy = gy;
      if (p.grab) continue;
      const rate = Math.hypot(p.vx, p.vy);
      // Loosely held to the hanging shape so the bulb carries its own momentum.
      const k = 0.09 + this.tuning.firmness * 0.2 * Math.min(1, rate / 1400);
      p.sx = (gx - p.px) * k;
      p.sy = (gy - p.py) * k;
      p.px += p.sx;
      p.py += p.sy;
      if (u > 0.55) {
        fx += p.px;
        fy += p.py;
        fn++;
      }
    }
    if (fn) this.faceAt = { x: fx / fn, y: fy / fn };
  }

  private splash(speed: number) {
    const count = Math.min(2, Math.floor(speed / 700));
    const bottom = this.bbox().bottom;
    for (let i = 0; i < count; i++) {
      const p = this.particles[Math.floor(Math.random() * this.particles.length)];
      this.drops.push({
        x: p.x,
        y: Math.min(p.y, bottom - 2),
        vx: (Math.random() - 0.5) * speed * 0.5,
        vy: -Math.random() * speed * 0.35,
        size: 1,
        age: 0,
        life: 3 + Math.random() * 4,
        stuck: false,
      });
    }
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Push a predicted position out of the walls and solids. True on contact. */
function collide(p: { x: number; y: number; px: number; py: number }, world: World, r: number): boolean {
  let hit = false;
  const b = world.bounds;
  if (p.px < b.left + r) {
    p.px = b.left + r;
    hit = true;
  } else if (p.px > b.right - r) {
    p.px = b.right - r;
    hit = true;
  }
  if (p.py < b.top + r) {
    p.py = b.top + r;
    hit = true;
  } else if (p.py > b.bottom - r) {
    p.py = b.bottom - r;
    hit = true;
  }
  for (const s of world.solids) {
    if (p.px <= s.left - r || p.px >= s.right + r || p.py <= s.top - r || p.py >= s.bottom + r) continue;
    // Resolve along the side it came from (smallest penetration from the
    // previous position's side), so things land on top rather than tunnel.
    const fromTop = p.y <= s.top - r + 0.5;
    const fromBottom = p.y >= s.bottom + r - 0.5;
    const fromLeft = p.x <= s.left - r + 0.5;
    const fromRight = p.x >= s.right + r - 0.5;
    if (fromTop) p.py = s.top - r;
    else if (fromBottom) p.py = s.bottom + r;
    else if (fromLeft) p.px = s.left - r;
    else if (fromRight) p.px = s.right + r;
    else {
      // Caught inside a solid that moved onto it (the message box growing):
      // the companion lives above the box, so never eject it out the bottom.
      const options = [
        { d: p.py - (s.top - r), apply: () => (p.py = s.top - r) },
        { d: p.px - (s.left - r), apply: () => (p.px = s.left - r) },
        { d: s.right + r - p.px, apply: () => (p.px = s.right + r) },
      ].sort((m, k) => m.d - k.d);
      options[0].apply();
    }
    hit = true;
  }
  return hit;
}
