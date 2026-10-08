import { useEffect, useRef } from "react";
import type { WorkspaceScene } from "../lib/workspace";
import { dissolveOrder, loaderDistances, loaderPalette, paintLoader, LOADER_SIZE, type BotGeometry } from "../lib/loader";

/** The pixel gradient animates at a chunky frame rate, like the bots do. */
const FRAME_MS = 1000 / 12;
/** How long the gradient takes to give way to a drawing that arrives while it plays. */
const DISSOLVE_MS = 900;

function drawScene(ctx: CanvasRenderingContext2D, scene: WorkspaceScene) {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = scene.palette[0];
  ctx.fillRect(0, 0, LOADER_SIZE, LOADER_SIZE);
  for (const [x, y, w, h, ink] of scene.rects) {
    ctx.fillStyle = scene.palette[ink];
    ctx.fillRect(x, y, w, h);
  }
}

/** The room. While its drawing is on the way, a pixel gradient of the bot's colour flows out from the bot's outline. */
export function Workspace({ scene, color, shape, geometry }: { scene: WorkspaceScene | null; color: string; shape: string; geometry: BotGeometry }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The last frame of the gradient, kept so the drawing can dissolve over it.
  const frozen = useRef<ImageData | null>(null);
  const playing = useRef(false);
  const { x: geometryX, y: geometryY, unit: geometryUnit } = geometry;

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (scene === null) {
      playing.current = true;
      const palette = loaderPalette(color);
      const distances = loaderDistances(shape, { x: geometryX, y: geometryY, unit: geometryUnit });
      const image = ctx.createImageData(LOADER_SIZE, LOADER_SIZE);
      const started = performance.now();
      const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const tick = () => {
        paintLoader(image.data, palette, distances, still ? 0 : (performance.now() - started) / 1000);
        ctx.putImageData(image, 0, 0);
        frozen.current = image;
        if (!still) timer = setTimeout(() => { frame = requestAnimationFrame(tick); }, FRAME_MS);
      };
      tick();
      return () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
      };
    }

    const from = playing.current ? frozen.current : null;
    playing.current = false;
    if (from === null || typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawScene(ctx, scene);
      return;
    }
    // The drawing arrived while the gradient was showing: dissolve into it block by block.
    const target = document.createElement("canvas");
    target.width = target.height = LOADER_SIZE;
    const targetCtx = target.getContext("2d");
    if (!targetCtx) {
      drawScene(ctx, scene);
      return;
    }
    drawScene(targetCtx, scene);
    const room = targetCtx.getImageData(0, 0, LOADER_SIZE, LOADER_SIZE);
    const mixed = ctx.createImageData(LOADER_SIZE, LOADER_SIZE);
    const order = dissolveOrder();
    const started = performance.now();
    const step = () => {
      const progress = Math.min(1, (performance.now() - started) / DISSOLVE_MS);
      for (let y = 0; y < LOADER_SIZE; y += 1) {
        for (let x = 0; x < LOADER_SIZE; x += 1) {
          const at = (y * LOADER_SIZE + x) * 4;
          const source = order[(y >> 3) * 16 + (x >> 3)] < progress * 1.02 ? room.data : from.data;
          mixed.data[at] = source[at];
          mixed.data[at + 1] = source[at + 1];
          mixed.data[at + 2] = source[at + 2];
          mixed.data[at + 3] = 255;
        }
      }
      ctx.putImageData(mixed, 0, 0);
      if (progress < 1) frame = requestAnimationFrame(step);
      else frozen.current = null;
    };
    step();
    return () => cancelAnimationFrame(frame);
  }, [scene, color, shape, geometryX, geometryY, geometryUnit]);

  return (
    <div className="bst-workspace" data-state={scene ? "ready" : "pending"} aria-hidden="true">
      <canvas ref={canvas} width={LOADER_SIZE} height={LOADER_SIZE} />
    </div>
  );
}
