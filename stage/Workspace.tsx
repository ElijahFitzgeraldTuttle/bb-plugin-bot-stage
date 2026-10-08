import { useEffect, useRef } from "react";
import type { WorkspaceScene } from "../lib/workspace";

export function Workspace({ scene }: { scene: WorkspaceScene | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 128, 128);
    if (!scene) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = scene.palette[0];
    ctx.fillRect(0, 0, 128, 128);
    for (const [x, y, w, h, ink] of scene.rects) {
      ctx.fillStyle = scene.palette[ink];
      ctx.fillRect(x, y, w, h);
    }
  }, [scene]);
  return (
    <div className="bst-workspace" data-state={scene ? "ready" : "pending"} aria-hidden="true">
      <canvas ref={canvas} width={128} height={128} />
    </div>
  );
}
