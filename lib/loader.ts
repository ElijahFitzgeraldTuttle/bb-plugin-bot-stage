// bb-plugin-bot-stage — the pixel gradient that holds a room's place while its
// drawing is on the way: bands of the bot's own colour that flow outward from
// the bot's outline, quantised to a small palette and dithered.

import { BODY_UNIT_PX, restParticles, shapeDistance } from "../vendor/sprites";

export const LOADER_SIZE = 128;
const STEPS = 8;
/** One band takes this many room pixels, measured outward from the bot's outline. */
const WAVELENGTH = 56;
/** Bands travel this many wavelengths a second. */
const SPEED = 0.14;

/** Where the bot stands, and how big its body is, in room pixels. */
export interface BotGeometry {
  /** The shape's centre (where its signed-distance function is zero in u and v). */
  x: number;
  y: number;
  /** Room pixels per body unit, the scale `shapeDistance` is measured in. */
  unit: number;
}

/** Where an actor's canvas sits in its room, from the lane styles in app.css. */
export interface ActorPlacement {
  k: number;
  width: number;
  height: number;
  anchor: number;
  left: number;
  bottom: number;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);
const FALLBACK = "#7ccf9a";

function rgbOf(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color)?.[1] ?? FALLBACK.slice(1);
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function toHsl([red, green, blue]: [number, number, number]): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const spread = max - min;
  const saturation = lightness > 0.5 ? spread / (2 - max - min) : spread / (max + min);
  const hue = max === r ? (g - b) / spread + (g < b ? 6 : 0) : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4;
  return [hue * 60, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (shift: number) => {
    let t = h + shift;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const value = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(value * 255);
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

/**
 * Hues of the bot's own colour, deeper to lighter, with a gentle drift of hue
 * so it reads as a gradient and not as one flat colour. Nothing goes dark: the
 * deepest step is still clearly the bot's colour.
 */
export function loaderPalette(color: string): Array<[number, number, number]> {
  const [hue, saturation, lightness] = toHsl(rgbOf(color));
  const base = Math.min(0.6, Math.max(0.42, lightness));
  const deep = Math.max(0.3, base - 0.14);
  const light = Math.min(0.84, base + 0.26);
  const chroma = Math.min(0.85, Math.max(0.45, saturation));
  return Array.from({ length: STEPS }, (_, step) => {
    const u = step / (STEPS - 1);
    return fromHsl(hue + (u - 0.45) * 30, chroma * (1 - 0.18 * u), deep + (light - deep) * u);
  });
}

/** The bot's centre and scale in its room, found the way its soft body finds its own rest position. */
export function botGeometry(shape: string, placement: ActorPlacement): BotGeometry {
  const particles = restParticles(shape, 3 * placement.k, placement.k);
  const count = Math.max(1, particles.length);
  const meanX = particles.reduce((sum, p) => sum + p.x, 0) / count;
  const meanY = particles.reduce((sum, p) => sum + p.y, 0) / count;
  const restBottom = particles.length === 0 ? 0 : Math.max(...particles.map((p) => p.y)) - meanY;
  const floor = placement.height - 3;
  const homeX = placement.width * placement.anchor;
  const homeY = floor - restBottom - 1;
  return {
    x: placement.left + homeX - meanX,
    y: LOADER_SIZE - placement.bottom - placement.height + homeY - meanY,
    unit: BODY_UNIT_PX * placement.k,
  };
}

/**
 * Distance of every pixel from the bot's outline (negative inside it), so the
 * bands follow its silhouette: a hexagon sends out hexagons, a cloud clouds.
 */
export function loaderDistances(shape: string, at: BotGeometry): Float32Array {
  const distances = new Float32Array(LOADER_SIZE * LOADER_SIZE);
  for (let y = 0; y < LOADER_SIZE; y += 1) {
    for (let x = 0; x < LOADER_SIZE; x += 1) {
      distances[y * LOADER_SIZE + x] = shapeDistance(shape, (x - at.x) / at.unit, (y - at.y) / at.unit, 0, 0) * at.unit;
    }
  }
  return distances;
}

/** The palette step for one pixel, `seconds` into the animation. */
export function loaderStep(x: number, y: number, distance: number, seconds: number): number {
  const phase = distance / WAVELENGTH - seconds * SPEED;
  const wrapped = phase - Math.floor(phase);
  const wave = wrapped < 0.5 ? wrapped * 2 : 2 - wrapped * 2;
  const position = wave * (STEPS - 1);
  const low = Math.floor(position);
  const fraction = position - low;
  return Math.min(STEPS - 1, low + (fraction > BAYER[(y & 3) * 4 + (x & 3)] ? 1 : 0));
}

/** Paint one frame of the gradient into `pixels` (RGBA, 128×128). */
export function paintLoader(
  pixels: Uint8ClampedArray,
  palette: ReadonlyArray<readonly [number, number, number]>,
  distances: Float32Array,
  seconds: number,
): void {
  for (let y = 0; y < LOADER_SIZE; y += 1) {
    for (let x = 0; x < LOADER_SIZE; x += 1) {
      const at = y * LOADER_SIZE + x;
      const [red, green, blue] = palette[loaderStep(x, y, distances[at], seconds)];
      pixels[at * 4] = red;
      pixels[at * 4 + 1] = green;
      pixels[at * 4 + 2] = blue;
      pixels[at * 4 + 3] = 255;
    }
  }
}

/** 0..1 per 8-pixel block: the order in which blocks give way to the drawing. */
export function dissolveOrder(): Float32Array {
  const order = new Float32Array(16 * 16);
  for (let at = 0; at < order.length; at += 1) {
    let h = Math.imul(at + 1, 374761393) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    order[at] = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  return order;
}
