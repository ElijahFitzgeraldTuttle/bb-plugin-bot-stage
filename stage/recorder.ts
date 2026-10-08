// Records the block draws of one frame so the canvas is only repainted when
// they change. Ported from bb-plugin-bot-companions (MIT, by Slicler): the
// sprites only ever draw solid rectangles, and most idle frames come out
// identical, so comparing the recording is far cheaper than uploading a new
// texture for every canvas on the stage thirty times a second.
type Op = number | string;

export class FrameRecorder {
  ops: Op[] = [];
  private scale = 1;

  reset(scale: number): void {
    this.ops.length = 0;
    this.scale = scale;
  }

  // The sprites read the device scale off the context's transform to snap
  // blocks to whole device pixels.
  getTransform(): DOMMatrix {
    return { a: this.scale } as DOMMatrix;
  }

  set fillStyle(value: string) {
    this.ops.push("s", value);
  }

  set globalAlpha(value: number) {
    this.ops.push("a", value);
  }

  beginPath(): void {
    this.ops.push("b");
  }

  fill(): void {
    this.ops.push("f");
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push("r", x, y, w, h);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push("R", x, y, w, h);
  }

  same(other: readonly Op[]): boolean {
    const mine = this.ops;
    if (mine.length !== other.length) return false;
    for (let index = 0; index < mine.length; index += 1) {
      if (mine[index] !== other[index]) return false;
    }
    return true;
  }

  replay(ctx: CanvasRenderingContext2D): void {
    const ops = this.ops;
    for (let index = 0; index < ops.length; ) {
      switch (ops[index++]) {
        case "s":
          ctx.fillStyle = ops[index++] as string;
          break;
        case "a":
          ctx.globalAlpha = ops[index++] as number;
          break;
        case "b":
          ctx.beginPath();
          break;
        case "f":
          ctx.fill();
          break;
        case "r":
          ctx.rect(ops[index++] as number, ops[index++] as number, ops[index++] as number, ops[index++] as number);
          break;
        case "R":
          ctx.fillRect(ops[index++] as number, ops[index++] as number, ops[index++] as number, ops[index++] as number);
          break;
      }
    }
    ctx.globalAlpha = 1;
  }
}
