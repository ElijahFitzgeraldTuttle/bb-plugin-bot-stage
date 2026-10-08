// bb-plugin-bot-stage — a bot as a still picture: the same blocky body, eyes and
// accessory the stage draws, small enough for a button. Pure SVG, no physics.
import { useMemo } from "react";
import { EYES, accessoryFor, baseEyes, shapeDistance } from "../vendor/sprites";
import type { Bot } from "../vendor/types";

const INK = "#101713";
/**
 * Body blocks are CELL svg units wide and sample the stage's silhouette at the
 * stage's own block pitch (PIXEL / body unit); eyes and accessories are finer.
 */
const CELL = 3;
const GRID = 12;
const SAMPLE = 0.847;
const PAD_X = 2;
const PAD_Y = 6;
const VIEW = 40;
const VIEW_H = 42;
/** One block of an accessory, in svg units. */
const A = 2.2;
/** One block of an eye. */
const E = 1.6;

type Rect = readonly [x: number, y: number, w: number, h: number, fill?: string];

function rowsToRects(rows: readonly string[], x0: number, y0: number, u: number, mirror = false): Rect[] {
  const out: Rect[] = [];
  const width = rows[0]?.length ?? 0;
  rows.forEach((row, r) =>
    [...row].forEach((c, k) => {
      if (c === "#") out.push([x0 + (mirror ? width - 1 - k : k) * u, y0 + r * u, u, u]);
    }),
  );
  return out;
}

/** Where the eyes look: a block left or right (x) and up or down (y), or straight ahead. */
export interface Gaze {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

/** Everything but the body colour: eyes first, then the accessory. */
export function bodyOf(bot: Bot, gaze: Gaze = { x: 0, y: 0 }): { cells: Array<[number, number]>; extras: Rect[] } {
  const shape = bot.avatar.shape;
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) if (shapeDistance(shape, (x - 5.5) * SAMPLE, (y - 5.5) * SAMPLE, 0, 0) <= 0) cells.push([x, y]);
  }
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const left = PAD_X + Math.min(...xs) * CELL;
  const right = PAD_X + (Math.max(...xs) + 1) * CELL;
  const top = PAD_Y + Math.min(...ys) * CELL;
  const ax = VIEW / 2;

  // Eyes sit a little lower on a triangle, as on stage.
  const eyeY = PAD_Y + 6 * CELL + 2 + (shape === "triangle" ? 3 : 0);
  const eyeX = 5;
  const pattern = EYES[baseEyes(bot)] ?? EYES.dot ?? ["##", "##"];
  const w = pattern[0]?.length ?? 2;
  const h = pattern.length;
  const extras: Rect[] = [];
  for (const [sx, mirror] of [[-1, false], [1, true]] as const) {
    for (const r of rowsToRects(pattern, ax + sx * eyeX - (w * E) / 2 + gaze.x * E, eyeY - (h * E) / 2 + gaze.y * E, E, mirror)) extras.push([r[0], r[1], r[2], r[3], INK]);
  }

  const tint = (rects: Rect[], fill: string): void => {
    for (const r of rects) extras.push([r[0], r[1], r[2], r[3], fill]);
  };
  switch (accessoryFor(bot)) {
    case "hardhat":
      tint(rowsToRects(["..###..", ".#####.", "#######"], ax - 3.5 * A, top - 2.4 * A, A), "#f2c230");
      break;
    case "beret":
      tint(rowsToRects(["...##..", ".#####.", "#######", ".#####."], ax - 3 * A, top - 3 * A, A), "#6b4ca8");
      break;
    case "bell":
      tint(rowsToRects(["..#..", ".###.", ".###.", "#####", "..#.."], ax - 2.5 * A, top - 4.4 * A, A), "#e0b23a");
      break;
    case "tie":
      tint(rowsToRects(["###", ".#.", "###", "###", ".#."], ax - 1.5 * A, eyeY + 4.5, A), "#b83232");
      break;
    case "headphones": {
      const cupTop = eyeY - 1.2 * A;
      for (const [x, dir] of [[left, -1], [right, 1]] as const) {
        extras.push([x - (dir < 0 ? 0.9 : 0.7) * A, cupTop, 1.6 * A, 3.2 * A, "#3a3f3d"]);
        extras.push([x - (dir < 0 ? 0.3 : 0.1) * A, cupTop - 1.2 * A, 0.6 * A + 0.2, 1.3 * A, "#3a3f3d"]);
      }
      break;
    }
    case "glasses": {
      const u = 1.24;
      for (const sx of [-1, 1]) {
        for (const r of rowsToRects(["#######", "#.....#", "#.....#", "#######"], ax + sx * eyeX - 3.5 * u, eyeY - 2 * u, u)) extras.push([r[0], r[1], r[2], r[3], INK]);
      }
      break;
    }
    case "antenna":
      extras.push([ax - A * 0.4, top - 2.8 * A, A * 0.8, 2.8 * A, INK]);
      extras.push([ax - A, top - 4.2 * A, 2 * A, 1.6 * A, "#ffd166"]);
      break;
    case "sprout":
      tint(rowsToRects(["##.##", ".###.", "..#..", "..#.."], ax - 2.5 * A, top - 3.6 * A, A), "#3fae5a");
      break;
    case "bow":
      tint(rowsToRects(["##.##", "#####", "##.##"], ax + 5, top - 1.6 * A, A), "#ff7aa8");
      break;
  }
  return { cells, extras };
}

export function BotPixel({ bot, size = 46, gaze }: { bot: Bot; size?: number; gaze?: Gaze }) {
  const { shape, color } = bot.avatar;
  const name = bot.name;
  const gx = gaze?.x ?? 0;
  const gy = gaze?.y ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parts = useMemo(() => bodyOf(bot, { x: gx, y: gy }), [shape, name, bot.id, gx, gy]);
  return (
    <svg
      className="bst-pixel"
      width={Math.round((size * (VIEW - 2)) / VIEW_H)}
      height={size}
      viewBox={`1 0 ${VIEW - 2} ${VIEW_H}`}
      shapeRendering="crispEdges"
      aria-hidden
    >
      <g fill={color}>
        {parts.cells.map(([x, y]) => (
          <rect key={`${x},${y}`} x={PAD_X + x * CELL} y={PAD_Y + y * CELL} width={CELL} height={CELL} />
        ))}
      </g>
      {parts.extras.map(([x, y, w, h, fill], index) => (
        <rect key={index} x={x} y={y} width={w} height={h} fill={fill ?? INK} />
      ))}
    </svg>
  );
}
