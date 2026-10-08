import { describe, expect, it } from "vitest";
import { botGeometry, dissolveOrder, loaderDistances, loaderPalette, loaderStep, paintLoader, LOADER_SIZE } from "./loader";
import { SIZES } from "../stage/model";

const compact = { ...SIZES.compact.actor, left: 5, bottom: 5 };
const roomy = { ...SIZES.roomy.actor, left: -8, bottom: 3 };
const lightness = ([r, g, b]: readonly number[]) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;

describe("loading gradient", () => {
  it("builds a ramp of hues of the bot's colour with no black in it", () => {
    for (const color of ["#7ccf9a", "#e8b04a", "#d9689a", "#5b8def", "#101713"]) {
      const ramp = loaderPalette(color);
      expect(ramp).toHaveLength(8);
      const lights = ramp.map(lightness);
      expect(lights).toEqual([...lights].sort((a, b) => a - b));
      expect(Math.min(...lights)).toBeGreaterThan(0.25);
      expect(new Set(ramp.map((c) => c.join())).size).toBe(8);
    }
  });

  it("gives different bots different gradients, and survives an unreadable colour", () => {
    expect(loaderPalette("#d9689a")).not.toEqual(loaderPalette("#5b8def"));
    expect(loaderPalette("not a colour")).toEqual(loaderPalette("#7ccf9a"));
  });

  it("finds the bot in its room's lower left, bigger in the roomy lane", () => {
    for (const placement of [compact, roomy]) {
      const at = botGeometry("round", placement);
      expect(at.x).toBeGreaterThan(15);
      expect(at.x).toBeLessThan(70);
      expect(at.y).toBeGreaterThan(70);
      expect(at.y).toBeLessThan(LOADER_SIZE);
    }
    expect(botGeometry("round", roomy).unit).toBeGreaterThan(botGeometry("round", compact).unit);
  });

  it("measures distance from the bot's outline, so the bands follow its shape", () => {
    const at = botGeometry("hexagon", compact);
    const distances = loaderDistances("hexagon", at);
    const pixel = (x: number, y: number) => distances[Math.round(y) * LOADER_SIZE + Math.round(x)];
    expect(pixel(at.x, at.y)).toBeLessThan(0);
    expect(pixel(0, 0)).toBeGreaterThan(40);
    const round = loaderDistances("round", botGeometry("round", compact));
    expect(Array.from(round)).not.toEqual(Array.from(distances));
  });

  it("moves the bands outward over time and always picks a real palette step", () => {
    for (const seconds of [0, 1.3, 7, 40]) {
      const step = loaderStep(60, 60, 50, seconds);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(8);
    }
    const row = (seconds: number) => Array.from({ length: 128 }, (_, x) => loaderStep(x, 90, Math.abs(x - 34), seconds)).join();
    expect(row(0)).not.toEqual(row(3));
  });

  it("paints every pixel opaque", () => {
    const pixels = new Uint8ClampedArray(LOADER_SIZE * LOADER_SIZE * 4);
    paintLoader(pixels, loaderPalette("#e8b04a"), loaderDistances("blob", botGeometry("blob", compact)), 2);
    for (let at = 3; at < pixels.length; at += 4) expect(pixels[at]).toBe(255);
  });

  it("orders blocks for the dissolve across the whole range", () => {
    const order = dissolveOrder();
    expect(order).toHaveLength(256);
    expect(Math.min(...order)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...order)).toBeLessThan(1);
    expect(new Set(order).size).toBeGreaterThan(200);
  });
});
