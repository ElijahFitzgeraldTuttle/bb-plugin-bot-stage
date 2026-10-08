import { describe, expect, it, vi } from "vitest";
import { Actor } from "./actor";
import { SIZES } from "./model";

describe("actor drawing overflow", () => {
  for (const [variant, size] of Object.entries(SIZES)) {
    it(`${variant}: gives expressions extra pixels without moving physics or hit targets`, () => {
      const ctx = {
        setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
        beginPath: vi.fn(), rect: vi.fn(), fill: vi.fn(),
      };
      const canvas = { style: {}, width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
      const actor = new Actor({
        canvas, ...size.actor, spawnDelay: 0,
        bot: { id: "test", name: "Test", mainThreadId: null,
          avatar: { color: "#f4a72c", shape: "cloud", expression: "happy", motion: "still" } },
      });
      actor.resize(size.actor.width, size.actor.height, 2);
      actor.set({ pose: { mood: "working", work: "edit" }, quietMs: 0, context: null, helpers: 3 });
      actor.tick(performance.now() + 100);
      expect(canvas.width).toBe((size.actor.width + 128) * 2);
      expect(canvas.height).toBe((size.actor.height + 64) * 2);
      expect(canvas.style.left).toBe("-64px");
      expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 128, 128);
      expect(actor.position?.x).toBeCloseTo(size.actor.width * size.actor.anchor);
      expect(ctx.fillRect).toHaveBeenCalled();
      const center = actor.position!;
      expect(actor.pointerDown(center.x, center.y)).toBe(true);
      actor.dispose();
    });
  }
});
