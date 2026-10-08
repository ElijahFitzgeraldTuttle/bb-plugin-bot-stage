import type { Bot, Work } from './types';
import type { Drop, SoftBody } from './softbody';
export const SIZE=112.5;
const BODY_UNIT_PX=9.375; // Original 6.25-unit silhouette × 1.5, independent of block pitch.
export const PIXEL=7.94; // ~15% bigger blocks for ~25% fewer of them; eyes stay the same size.
/** Everything drawn is multiplied by view.k: 1 on desktop, smaller on phones. */
export const view = { k: 1 };
/** Screen-size scale: full size on desktop, about 60% on a phone. */
export function screenScale(): number {
  const w = Math.min(window.innerWidth, window.innerHeight * 1.2);
  return w <= 640 ? 0.6 : w <= 1000 ? 0.8 : 1;
}
export function shapeDistance(shape:string,u:number,v:number,phase:number,fluid:number){
  u-=Math.sin(v*.7+phase)*fluid*.32;v-=Math.cos(u*.6-phase)*fluid*.23;
  switch(shape){
    case 'triangle':return Math.max((Math.abs(u)-.54*(v+4.4))/.88,v-3.7,-v-4.4);
    case 'cloud':return Math.min(Math.hypot(u+2.8,v-.7)-2.1,Math.hypot(u+.8,v+1.1)-2.6,Math.hypot(u-2,v+.1)-2.4,Math.hypot(u-.1,v-1.7)-2.3);
    case 'blob':return Math.hypot(u/.91,v/1.07)-3.8-fluid*.2*Math.sin(Math.atan2(v,u)*3+phase);
    case 'squircle':return Math.pow(Math.abs(u)**4+Math.abs(v)**4,.25)-3.7;
    case 'capsule':return Math.hypot(Math.max(0,Math.abs(u)-1.5),v)-2.6;
    case 'hexagon':return Math.max(Math.abs(u)*.866+Math.abs(v)*.5,Math.abs(v))-3.5;
    default:return Math.hypot(u,v)-3.8;
  }
}
export function sprite(bot:Bot):string{
  let marks='';for(let y=0;y<12;y++)for(let x=0;x<12;x++)if(shapeDistance(bot.avatar.shape,x-5.5,y-5.5,0,0)<=0)marks+=`<rect x="${x}" y="${y}" width="1" height="1" fill="${bot.avatar.color}"/>`;
  marks+='<path d="M4 6h1v1H4zm3 0h1v1H7z" fill="#101713"/>';
  return 'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" shape-rendering="crispEdges">${marks}</svg>`);
}

// ── Soft-body rendering ─────────────────────────────────────────────────

/** Particle rest positions filling the bot's silhouette, in px from its center. */
export function restParticles(shape: string, spacing: number, k = 1): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const BODY_UNIT = BODY_UNIT_PX * k;
  const reach = 6 * BODY_UNIT;
  for (let y = -reach; y <= reach; y += spacing)
    for (let x = -reach; x <= reach; x += spacing * 0.866) {
      // Hex-ish packing: offset alternate columns for an even fill.
      const col = Math.round((x + reach) / (spacing * 0.866));
      const yy = y + (col % 2 ? spacing / 2 : 0);
      if (shapeDistance(shape, x / BODY_UNIT, yy / BODY_UNIT, 0, 0) <= -0.35) out.push({ x, y: yy });
    }
  return out;
}

/**
 * Fill every grid cell whose metaball field (summed from the particles)
 * crosses the threshold. The grid is fixed to the screen, so the body is
 * always made of the same square blocks and its edge crawls cell by cell as
 * it moves and deforms, like liquid pixels.
 */
export function drawBody(ctx: CanvasRenderingContext2D, body: SoftBody, color: string, solids: { left: number; top: number; right: number; bottom: number }[] = []) {
  const cell = PIXEL * view.k;
  const R = body.spacing * 1.35;
  const R2 = R * R;
  const box = body.bbox(R);
  const scale = ctx.getTransform().a;
  const snap = (n: number) => Math.round(n * scale) / scale;
  const x0 = Math.floor(box.left / cell);
  const x1 = Math.ceil(box.right / cell);
  const y0 = Math.floor(box.top / cell);
  const y1 = Math.ceil(box.bottom / cell);
  const ps = body.particles;
  // Hysteresis: a cell turns on above ON and only turns off below OFF, so
  // edges don't flicker from tiny jiggles.
  const ON = 0.46;
  const OFF = 0.33;
  const was = body.cells;
  const now = new Set<number>();
  // Only links stretched past their rest length draw strands, so find them once
  // per frame instead of for every empty cell.
  const near = body.spacing * body.spacing;
  const strands: { ax: number; ay: number; sx: number; sy: number; len2: number }[] = [];
  for (const [i, j] of body.links) {
    const a = ps[i];
    const b = ps[j];
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const len2 = sx * sx + sy * sy;
    if (len2 >= near * 1.6 && len2 <= near * 36) strands.push({ ax: a.x, ay: a.y, sx, sy, len2 });
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let iy = y0; iy <= y1; iy++) {
    const cy = (iy + 0.5) * cell;
    for (let ix = x0; ix <= x1; ix++) {
      const cx = (ix + 0.5) * cell;
      let field = 0;
      for (const p of ps) {
        const dx = cx - p.x;
        const dy = cy - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        const f = 1 - d2 / R2;
        field += f * f;
        if (field >= ON) break;
      }
      // Strands between neighbours keep a stretched body continuous (until
      // it actually tears).
      if (field < ON) {
        for (const l of strands) {
          const t = Math.max(0, Math.min(1, ((cx - l.ax) * l.sx + (cy - l.ay) * l.sy) / l.len2));
          const dx = cx - (l.ax + l.sx * t);
          const dy = cy - (l.ay + l.sy * t);
          const d2 = dx * dx + dy * dy;
          if (d2 >= R2) continue;
          const f = 1 - d2 / R2;
          field = Math.max(field, f * f * 0.75);
          if (field >= ON) break;
        }
      }
      // Never draw into a solid surface (no stray block poking into the box).
      if (solids.some((r) => cx > r.left && cx < r.right && cy > r.top && cy < r.bottom)) continue;
      const key = iy * 100003 + ix;
      if (field >= ON || (field >= OFF && was.has(key))) {
        now.add(key);
        const a = snap(ix * cell);
        const b = snap(iy * cell);
        ctx.rect(a, b, snap((ix + 1) * cell) - a, snap((iy + 1) * cell) - b);
      }
    }
  }
  body.cells = now;
  ctx.fill();
}

/** Shed bits: full cells while fresh, then crumbling into smaller pieces. */
export function drawDrops(ctx: CanvasRenderingContext2D, drops: Drop[], color: string) {
  const cell = PIXEL * view.k;
  const scale = ctx.getTransform().a;
  const snap = (n: number) => Math.round(n * scale) / scale;
  ctx.fillStyle = color;
  for (const q of drops) {
    const life = q.age / q.life;
    const gx = Math.floor(q.x / cell) * cell;
    const gy = Math.floor(q.y / cell) * cell;
    ctx.globalAlpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4;
    if (life < 0.45) {
      // Splatted drops spread sideways into a short puddle.
      for (let i = 0; i < q.size; i++) ctx.fillRect(snap(gx + (i - Math.floor(q.size / 2)) * cell), snap(gy), snap(cell), snap(cell));
    } else {
      // Crumbling: quarter-cells that drift apart and vanish one by one.
      const bits = Math.max(1, Math.round((1 - life) * 4 * q.size));
      const half = cell / 2;
      for (let i = 0; i < bits; i++) {
        const ox = ((i * 37) % 3) - 1;
        const oy = (i * 53) % 2;
        ctx.fillRect(snap(gx + ox * half * (1 + life)), snap(gy + oy * half), snap(half), snap(half));
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ── Faces ───────────────────────────────────────────────────────────────
// Eyes and mouths are tiny pixel patterns ('#' = a dark block), drawn at a
// fixed 3.125px unit so they stay the same size whatever the body does. Left
// eye patterns are mirrored for the right eye.

export type Mood = 'idle' | 'watching' | 'thinking' | 'talking' | 'working' | 'needs' | 'done' | 'failed' | 'sleeping' | 'held';
export type Expression = 'base' | 'dot' | 'wide' | 'narrow' | 'happy' | 'blink' | 'lookL' | 'lookR' | 'lookUp' | 'surprised' | 'focused' | 'up';

const EYES: Record<string, string[]> = {
  dot: ['##', '##'],
  wide: ['.##.', '####', '####', '.##.'],
  narrow: ['####'],
  happy: ['.##.', '#..#'],
  blink: ['###'],
  sleepy: ['###'],
  mischief: ['#..', '##.', '.##', '..#'],
  surprised: ['###', '#.#', '###'],
  focused: ['###', '###'],
  up: ['##', '##'],
  x: ['#.#', '.#.', '#.#'],
  worried: ['#..#', '.##.'],
};
const MOUTHS: Record<string, string[]> = {
  closed: ['####'],
  small: ['##', '##'],
  open: ['.##.', '####', '####', '.##.'],
  o: ['.#.', '#.#', '.#.'],
  smile: ['#..#', '.##.'],
  frown: ['.##.', '#..#'],
};

/** The bot's resting eyes, from its avatar shape. */
export function baseEyes(bot: Bot): string {
  const shape = bot.avatar.shape;
  return shape === 'round' ? 'happy' : shape === 'cloud' ? 'dot' : shape === 'triangle' ? 'mischief' : 'sleepy';
}

export interface FaceState {
  mood: Mood;
  expr: Expression;
  gaze: { x: number; y: number } | null;
  talk: number; // 0..1 mouth openness
  now: number;
  work?: Work | null; // what the agent is doing, while mood is 'working'
  stress?: number; // 0..3: commands failing in a row
  relief?: boolean; // the failures just stopped
  context?: number | null; // share of the context window used, 0..1
  queued?: number; // messages waiting behind the running turn
  chewing?: boolean; // just ate a queued message
  waking?: boolean; // just woke up
}

export function drawFace(ctx: CanvasRenderingContext2D, bot: Bot, body: SoftBody, face: FaceState) {
  const f = body.frame;
  const scale = ctx.getTransform().a;
  const snap = (n: number) => Math.round(n * scale) / scale;
  const k = view.k;
  const U = 3.125 * k;
  const ek = 0.45 + 0.55 * k; // eye spacing eases off a little less than the body
  const block = (x: number, y: number) => ctx.fillRect(snap(x), snap(y), snap(x + U) - snap(x), snap(y + U) - snap(y));
  const pattern = (rows: string[], cx: number, cy: number, mirror = false, u = U) => {
    const w = rows[0].length;
    const h = rows.length;
    const x0 = cx - (w * u) / 2;
    const y0 = cy - (h * u) / 2;
    rows.forEach((row, r) =>
      [...row].forEach((c, k) => {
        if (c !== '#') return;
        const x = x0 + (mirror ? w - 1 - k : k) * u;
        const y = y0 + r * u;
        ctx.fillRect(snap(x), snap(y), snap(x + u) - snap(x), snap(y + u) - snap(y));
      }),
    );
  };

  const held = body.held;
  const shape = bot.avatar.shape;
  const at = body.faceAt;
  const lift = held ? 0 : shape === 'triangle' ? 9 * k : 0;
  // Squash the face spacing a little with the body, but never rotate it.
  const wide = held ? 1 : Math.max(0.8, Math.min(1.3, Math.hypot(f.a, f.c)));

  // Which eyes: mood first, then the idle expression, then the bot's own.
  let eyes = baseEyes(bot);
  let dx = 0;
  let dy = 0;
  if (face.mood === 'held') eyes = 'surprised';
  else if (face.mood === 'thinking') {
    eyes = 'up';
    dx = 1.4 * U;
    dy = -1.6 * U;
  } else if (face.mood === 'working') {
    // Each kind of work gets its own look: scanning lines, darting about, or heads-down.
    const w = face.work;
    eyes = w === 'read' || w === 'search' ? 'dot' : 'focused';
    if (w === 'read') dx = Math.sin(face.now / 260) * 1.8 * U;
    else if (w === 'search') dx = (Math.floor(face.now / 330) % 3 - 1) * 1.8 * U;
    else if (w === 'web') dy = -0.8 * U;
    else dy = 1.2 * U;
    if ((face.stress ?? 0) >= 2) eyes = 'worried';
  } else if (face.mood === 'needs') eyes = 'wide';
  else if (face.mood === 'done') eyes = 'happy';
  else if (face.mood === 'failed') eyes = 'x';
  else if (face.mood === 'sleeping') eyes = 'blink';
  else if (face.mood === 'watching') eyes = 'focused';
  else if (face.mood === 'talking') eyes = face.talk > 0.6 ? 'happy' : baseEyes(bot);
  if (face.expr === 'blink') eyes = 'blink';
  else if (face.mood === 'idle' && face.expr !== 'base') {
    if (face.expr === 'lookL') {
      eyes = 'dot';
      dx = -1.6 * U;
    } else if (face.expr === 'lookR') {
      eyes = 'dot';
      dx = 1.6 * U;
    } else if (face.expr === 'lookUp') {
      eyes = 'dot';
      dy = -1.4 * U;
    } else eyes = face.expr;
  }
  // Gaze: eyes drift toward what it's looking at (the caret, your cursor).
  if (face.gaze && (face.mood === 'watching' || (face.mood === 'idle' && face.expr === 'base') || face.mood === 'talking')) {
    const gx = face.gaze.x - at.x;
    const gy = face.gaze.y - at.y;
    const l = Math.hypot(gx, gy) || 1;
    const reach = face.mood === 'watching' ? 1.4 : 0.8;
    dx += (gx / l) * reach * U;
    dy += (gy / l) * reach * U;
  }

  ctx.fillStyle = '#101713';
  const rows = EYES[eyes] ?? EYES.dot;
  const mirrorRight = eyes === 'mischief';
  pattern(rows, at.x - 12 * ek * wide + dx, at.y + lift - 2 * k + dy);
  pattern(rows, at.x + 12 * ek * wide + dx, at.y + lift - 2 * k + dy, mirrorRight);

  // Mouth: talking flaps through three shapes; happy idle smiles.
  let mouth: string | null = null;
  const yawning = face.mood === 'idle' && (face.context ?? 0) >= 0.85 && face.now % 9000 < 1500;
  if (face.mood === 'talking') mouth = face.talk > 0.66 ? 'open' : face.talk > 0.3 ? 'small' : 'closed';
  else if (face.mood === 'needs') mouth = 'o';
  else if (face.mood === 'done' || face.relief) mouth = 'smile';
  else if (face.mood === 'failed' || (face.mood === 'working' && (face.stress ?? 0) >= 2)) mouth = 'frown';
  else if (face.chewing) mouth = Math.floor(face.now / 110) % 2 ? 'open' : 'small';
  else if (yawning) mouth = 'o';
  else if (face.mood === 'idle' && face.expr === 'happy') mouth = 'smile';
  if (mouth) pattern(MOUTHS[mouth], at.x + dx * 0.4, at.y + lift + 11 * k + dy * 0.3);

  drawExtras(ctx, bot, body, face, U, k, at.x, at.y + lift - 2 * k, 12 * ek * wide);
  const prop: Prop | null = face.mood === 'working' ? face.work ?? null : face.mood === 'needs' ? 'ask' : face.mood === 'done' ? 'check' : face.mood === 'sleeping' ? 'sleep' : null;
  if (prop) drawWork(ctx, prop, at.x + 52 * k, body.bbox().top - 44 * k + Math.sin(face.now / 650) * 3 * k, U * 2, face.now);

  // Thinking: a cloud-shaped thought bubble that bobs, with dots filling in.
  if (face.mood === 'thinking') {
    const top = body.bbox().top;
    const bob = Math.sin(face.now / 650) * 3 * k;
    const C = U * 1.5; // the bubble is drawn in bigger blocks
    const bx = at.x + 44 * k;
    const by = top - 40 * k + bob;
    ctx.fillStyle = 'rgba(236, 242, 237, 0.94)';
    // trail of blocks rising to the cloud, getting bigger
    pattern(['#'], at.x + 12 * k, top - 6 * k + bob * 0.3, false, U);
    pattern(['##', '##'], at.x + 20 * k, top - 15 * k + bob * 0.6, false, U);
    // the cloud: a lumpy 11×6 shape
    const cloud = ['..###.###..', '.#########.', '###########', '###########', '.#########.', '...#####...'];
    pattern(cloud, bx, by, false, C);
    const step = Math.floor(face.now / 420) % 4;
    ctx.fillStyle = '#101713';
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = i < step ? 0.9 : 0.22;
      pattern(['#'], bx - 3 * C + i * 3 * C, by + C * 0.5, false, C);
    }
    ctx.globalAlpha = 1;
  }
}

// ── Work props ──────────────────────────────────────────────────────────
// A little animated prop floats beside the bot while it works: a terminal
// for commands, a page for reading, a magnifier for searching, a globe for
// the web, a page with a pencil for edits and a cog for other tools.
const PAPER = 'rgba(236, 242, 237, 0.94)';
const INK = '#101713';

type Prop = Work | 'ask' | 'check' | 'sleep';

function drawWork(ctx: CanvasRenderingContext2D, work: Prop, cx: number, cy: number, C: number, now: number) {
  const scale = ctx.getTransform().a;
  const snap = (n: number) => Math.round(n * scale) / scale;
  // A grid prop is W×H cells centered on (cx, cy); cells are [col, row] pairs.
  const cell = (ox: number, oy: number, c: number, r: number, w = 1) =>
    ctx.fillRect(snap(ox + c * C), snap(oy + r * C), snap(ox + (c + w) * C) - snap(ox + c * C), snap(oy + (r + 1) * C) - snap(oy + r * C));
  const shape = (rows: string[], ox: number, oy: number) =>
    rows.forEach((row, r) => [...row].forEach((ch, c) => ch === '#' && cell(ox, oy, c, r)));
  // Every prop sits on a dark panel, so it reads on light and dark themes alike.
  const origin = (w: number, h: number, pad = 1) => {
    const ox = cx - (w * C) / 2;
    const oy = cy - (h * C) / 2;
    ctx.fillStyle = 'rgba(16, 23, 19, 0.9)';
    ctx.fillRect(snap(ox - pad * C), snap(oy - pad * C), snap(ox + (w + pad) * C) - snap(ox - pad * C), snap(oy + (h + pad) * C) - snap(oy - pad * C));
    return { ox, oy };
  };
  const tick = (ms: number) => Math.floor(now / ms);

  if (work === 'run') {
    const { ox, oy } = origin(10, 7);
    ctx.fillStyle = PAPER;
    shape(Array(7).fill('##########'), ox, oy);
    ctx.fillStyle = INK;
    shape(['#.', '.#', '#.'], ox + C, oy + C); // the prompt
    const a = 1 + (tick(170) % 5);
    const b = 1 + ((tick(170) + 2) % 4);
    cell(ox, oy, 4, 1, a); // output lines fill in
    cell(ox, oy, 4, 3, b);
    if (tick(380) % 2) cell(ox, oy, 1, 5, 2); // blinking cursor
  } else if (work === 'read') {
    const { ox, oy } = origin(8, 9);
    ctx.fillStyle = PAPER;
    shape(Array(9).fill('########'), ox, oy);
    const lines = [6, 5, 6, 4];
    const at = tick(360) % lines.length;
    lines.forEach((len, i) => {
      ctx.fillStyle = INK;
      ctx.globalAlpha = i === at ? 1 : 0.3; // the line being read lights up
      cell(ox, oy, 1, 1 + i * 2, len);
    });
    ctx.globalAlpha = 1;
  } else if (work === 'search') {
    const { ox, oy } = origin(11, 9, 0);
    // The magnifier sweeps a small circle across the panel.
    const sx = (2 + Math.cos(now / 420) * 1.8) * C;
    const sy = (0.8 + Math.sin(now / 420) * 1.1) * C;
    ctx.fillStyle = PAPER;
    shape(['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....#..', '.....#.'], ox + sx, oy + sy);
  } else if (work === 'web') {
    const { ox, oy } = origin(7, 7);
    ctx.fillStyle = PAPER;
    shape(['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'], ox, oy);
    ctx.fillStyle = INK;
    const m = 1 + (tick(240) % 5); // a meridian rolls across the globe
    for (let r = 1; r <= 5; r++) if (m > 1 && m < 5 ? true : r > 1 && r < 5) cell(ox, oy, m, r);
    ctx.globalAlpha = 0.5;
    cell(ox, oy, 0, 3, 7); // the equator
    ctx.globalAlpha = 1;
  } else if (work === 'edit') {
    const { ox, oy } = origin(9, 7);
    ctx.fillStyle = PAPER;
    shape(Array(7).fill('#########'), ox, oy);
    ctx.fillStyle = INK;
    const t = tick(150) % 21; // three lines get written in turn
    const row = Math.floor(t / 7);
    for (let r = 0; r <= row; r++) cell(ox, oy, 1, 1 + r * 2, r < row ? 6 : Math.min(6, (t % 7) + 1));
    const end = Math.min(6, (t % 7) + 1);
    shape(['.#', '#.'], ox + (1 + end) * C, oy + (1 + row * 2 - 1) * C); // the pencil tip
  } else if (work === 'ask') {
    // Needs you: a flashing question mark.
    const { ox, oy } = origin(7, 9);
    ctx.fillStyle = tick(260) % 2 ? PAPER : '#ffd166';
    shape(Array(9).fill('#######'), ox, oy);
    ctx.fillStyle = INK;
    shape(['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'], ox + C, oy + C);
  } else if (work === 'check') {
    const { ox, oy } = origin(7, 5);
    ctx.fillStyle = PAPER;
    shape(Array(5).fill('#######'), ox, oy);
    ctx.fillStyle = '#2f9e6e';
    shape(['.....#.', '....##.', '#..##..', '.###...', '..#....'], ox, oy);
  } else if (work === 'sleep') {
    // Three z's light up in turn.
    const { ox, oy } = origin(9, 7);
    const lit = tick(500) % 4;
    [
      { c: 0, r: 4, big: false },
      { c: 3, r: 2, big: false },
      { c: 5, r: 0, big: true },
    ].forEach((z, n) => {
      ctx.fillStyle = PAPER;
      ctx.globalAlpha = n < lit ? 1 : 0.25;
      shape(z.big ? ['####', '..#.', '.#..', '####'] : ['###', '.#.', '###'], ox + z.c * C, oy + z.r * C);
    });
    ctx.globalAlpha = 1;
  } else {
    const { ox, oy } = origin(7, 7);
    ctx.fillStyle = PAPER;
    shape(
      tick(300) % 2
        ? ['..#.#..', '.#####.', '##...##', '.#...#.', '##...##', '.#####.', '..#.#..']
        : ['#.....#', '.#####.', '.#...#.', '.#...#.', '.#...#.', '.#####.', '#.....#'],
      ox,
      oy,
    );
  }
}

// ── Reactions, accessories and little friends ───────────────────────────
function kit(ctx: CanvasRenderingContext2D) {
  const scale = ctx.getTransform().a;
  const snap = (n: number) => Math.round(n * scale) / scale;
  const rect = (x: number, y: number, w: number, h: number) => ctx.fillRect(snap(x), snap(y), snap(x + w) - snap(x), snap(y + h) - snap(y));
  const rows = (r: string[], ox: number, oy: number, u: number) =>
    r.forEach((row, ry) => [...row].forEach((ch, cx) => ch === '#' && rect(ox + cx * u, oy + ry * u, u, u)));
  return { rect, rows };
}

export type Accessory = 'hardhat' | 'tie' | 'bell' | 'beret' | 'headphones' | 'glasses' | 'antenna' | 'sprout' | 'bow';

/** A small signature accessory, chosen from the bot's name (or its id for the rest). */
export function accessoryFor(bot: Bot): Accessory {
  const n = bot.name.toLowerCase();
  if (/architect|engineer|build/.test(n)) return 'hardhat';
  if (/coach|business/.test(n)) return 'tie';
  if (/remind|alarm|clock/.test(n)) return 'bell';
  if (/design|art|creative/.test(n)) return 'beret';
  if (/studio|music|audio|video/.test(n)) return 'headphones';
  if (/manager|admin|ops/.test(n)) return 'glasses';
  let h = 0;
  for (const c of bot.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (['antenna', 'sprout', 'bow'] as const)[h % 3];
}

function drawExtras(ctx: CanvasRenderingContext2D, bot: Bot, body: SoftBody, face: FaceState, U: number, k: number, ax: number, eyeY: number, eyeX: number) {
  const { rect, rows } = kit(ctx);
  const b = body.bbox();
  const now = face.now;
  const stress = face.stress ?? 0;

  // Sweat drops while commands keep failing.
  if (stress >= 1 || face.mood === 'failed') {
    const n = Math.max(1, Math.min(3, stress));
    for (let i = 0; i < n; i++) {
      const fall = ((now / 150 + i * 4) % 10) * U * 0.55;
      ctx.fillStyle = '#7cc7ff';
      rows(['.#.', '###', '###'], ax + (24 + i * 9) * k, b.top + 6 * k + fall, U * 0.8);
    }
  }

  // Sparkles around a bot that just finished.
  if (face.mood === 'done') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + now / 900;
      const r = (50 + Math.sin(now / 300 + i) * 6) * k;
      const x = ax + Math.cos(a) * r;
      const y = eyeY + Math.sin(a) * r * 0.8;
      const big = (Math.floor(now / 160) + i) % 3 !== 0;
      ctx.fillStyle = INK;
      ctx.globalAlpha = 0.45;
      rows(big ? ['.#.', '###', '.#.'] : ['#'], x - U * 0.4, y - U * 0.4, U * 0.9);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffcf33';
      rows(big ? ['.#.', '###', '.#.'] : ['#'], x - U * 1.35, y - U * 1.35, U * 0.9);
    }
  }

  // Context meter: a little stack of blocks that fills, amber then red.
  const used = face.context ?? 0;
  if (used >= 0.5 && !body.held) {
    const lit = Math.min(5, Math.ceil(used * 5));
    const hot = used >= 0.9 ? '#e8483f' : used >= 0.7 ? '#f2a63a' : '#7ccf9a';
    const x = b.left - 16 * k;
    for (let i = 0; i < 5; i++) {
      const y = b.bottom - (i + 1) * U * 1.7;
      ctx.fillStyle = INK;
      rect(x - 2, y - 2, U * 2 + 4, U * 1.4 + 4);
      ctx.fillStyle = i < lit ? hot : 'rgba(236, 242, 237, 0.3)';
      rect(x, y, U * 2, U * 1.4);
    }
  }

  // Queued messages wait beside the bot as little blocks; it nibbles them away.
  const queued = Math.min(6, face.queued ?? 0);
  for (let i = 0; i < queued; i++) {
    const bob = Math.abs(Math.sin(now / 260 + i * 0.9)) * U * 0.9;
    const x = b.right + 10 * k + i * (U * 2.8);
    const y = b.bottom - U * 2.4 - bob;
    ctx.fillStyle = INK;
    rect(x, y, U * 2.4, U * 2.4);
    ctx.fillStyle = PAPER;
    rect(x + U * 0.5, y + U * 0.5, U * 1.4, U * 1.4);
  }

  // Signature accessory.
  if (body.held) return;
  const A = U * 1.6;
  const top = b.top;
  switch (accessoryFor(bot)) {
    case 'hardhat':
      ctx.fillStyle = '#f2c230';
      rows(['..###..', '.#####.', '#######'], ax - 3.5 * A, top - 2.4 * A, A);
      break;
    case 'beret':
      ctx.fillStyle = '#6b4ca8';
      rows(['...##..', '.#####.', '#######', '.#####.'], ax - 3 * A, top - 3 * A, A);
      break;
    case 'bell': {
      const ring = Math.sin(now / 110) * (Math.floor(now / 3000) % 2 ? A * 0.5 : 0);
      ctx.fillStyle = '#e0b23a';
      rows(['..#..', '.###.', '.###.', '#####', '..#..'], ax - 2.5 * A + ring, top - 4.4 * A, A);
      break;
    }
    case 'tie':
      ctx.fillStyle = '#b83232';
      rows(['###', '.#.', '###', '###', '.#.'], ax - 1.5 * A, eyeY + 12 * k, A);
      break;
    case 'headphones': {
      // Ear cups with a short band over each, so it fits narrow and wide bodies alike.
      ctx.fillStyle = '#3a3f3d';
      const cupTop = eyeY - 1.2 * A;
      for (const [x, dir] of [[b.left, -1], [b.right, 1]] as const) {
        rect(x - (dir < 0 ? 0.9 : 0.7) * A, cupTop, 1.6 * A, 3.2 * A);
        rect(x - (dir < 0 ? 0.3 : 0.1) * A, cupTop - 1.2 * A, 0.6 * A + 1, 1.3 * A);
      }
      break;
    }
    case 'glasses': {
      const u = U * 1.05;
      ctx.fillStyle = INK;
      for (const sx of [-1, 1]) rows(['#######', '#.....#', '#.....#', '#######'], ax + sx * eyeX - 3.5 * u, eyeY - 2 * u, u);
      rect(ax - eyeX + 3.5 * u, eyeY - 1.2 * u, 2 * eyeX - 7 * u, u * 0.8);
      break;
    }
    case 'antenna':
      ctx.fillStyle = INK;
      rect(ax - A * 0.4, top - 2.8 * A, A * 0.8, 2.8 * A);
      ctx.fillStyle = Math.floor(now / 600) % 2 ? '#ffd166' : '#e8483f';
      rect(ax - A, top - 4.2 * A, 2 * A, 1.6 * A);
      break;
    case 'sprout':
      ctx.fillStyle = '#3fae5a';
      rows(['##.##', '.###.', '..#..', '..#..'], ax - 2.5 * A, top - 3.6 * A, A);
      break;
    case 'bow':
      ctx.fillStyle = '#ff7aa8';
      rows(['##.##', '#####', '##.##'], ax + 6 * k, top - 1.6 * A, A);
      break;
  }
}

/** A small copy of a bot, for visitors and helpers standing beside the companion. */
export function drawMini(ctx: CanvasRenderingContext2D, x: number, baseY: number, shape: string, color: string, k: number, now: number, phase: number, working = false) {
  const { rect } = kit(ctx);
  const s = 3.3 * k;
  const hop = working ? Math.abs(Math.sin(now / 170 + phase)) * 4 * k : Math.max(0, Math.sin(now / 900 + phase)) ** 6 * 3 * k;
  const x0 = x - 6 * s;
  const y0 = baseY - 11 * s - hop;
  ctx.fillStyle = color;
  for (let y = 0; y < 12; y++) for (let c = 0; c < 12; c++) if (shapeDistance(shape, c - 5.5, y - 5.5, 0, 0) <= 0) rect(x0 + c * s, y0 + y * s, s, s);
  ctx.fillStyle = '#101713';
  rect(x0 + 4 * s, y0 + 5.5 * s, s, s);
  rect(x0 + 7 * s, y0 + 5.5 * s, s, s);
}
