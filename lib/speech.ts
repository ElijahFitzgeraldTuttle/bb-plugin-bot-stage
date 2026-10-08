// bb-plugin-bot-stage — turning an agent's message into what a bot says.
//
// An agent's reply is markdown, and a speech bubble is three lines of plain
// text. This module does the translation (strip the syntax, keep list items
// and inline code, cut at a word) and owns the typewriter that reveals it.
//
// Providers differ in how a reply arrives: Codex streams token by token,
// Claude Code delivers each message whole in a few milliseconds. The
// typewriter exists so that both read as speech — and so a message that grows
// while it is being typed carries on instead of starting over.

/** A run of visible text, and whether it was `inline code`. */
export type Seg = { text: string; code: boolean };

const BULLET = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+/u;

/** Strip emphasis, links and images from one line, leaving `code` spans apart. */
function inline(line: string): Seg[] {
  const out: Seg[] = [];
  const parts = line.split(/(`[^`\n]+`)/u);
  for (const part of parts) {
    if (part === "") continue;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push({ text: part.slice(1, -1), code: true });
      continue;
    }
    const plain = part
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/(\*\*|__)(.+?)\1/gu, "$2")
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?])/gu, "$1$2")
      .replace(/~~(.+?)~~/gu, "$1");
    if (plain !== "") out.push({ text: plain, code: false });
  }
  return out;
}

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const seg of segs) {
    if (seg.text === "") continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.code === seg.code) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

/**
 * The visible text of a markdown message, as runs. Headings and quotes lose
 * their marker, list items become "• item", fenced code is kept as code, and
 * blank lines are dropped — a bubble has no room for paragraph gaps.
 */
export function plainSegments(markdown: string): Seg[] {
  const segs: Seg[] = [];
  let fenced = false;
  let first = true;
  const newline = () => {
    if (!first) segs.push({ text: "\n", code: false });
    first = false;
  };
  for (const raw of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (line.trim() === "") continue;
      newline();
      segs.push({ text: line.trim(), code: true });
      continue;
    }
    if (line.trim() === "") continue;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) continue; // a rule
    let body = line.replace(/^\s{0,3}#{1,6}\s+/u, "").replace(/^\s*>\s?/u, "");
    const bullet = BULLET.exec(body);
    newline();
    if (bullet !== null) {
      const ordered = /\d/u.test(bullet[0]);
      const marker = ordered ? bullet[0].trim().replace(/\s+$/u, "") + " " : "• ";
      body = body.slice(bullet[0].length);
      segs.push({ text: marker, code: false });
    }
    segs.push(...inline(body.trim()));
  }
  return merge(segs);
}

/** How many characters are visible across the runs. */
export function visibleLength(segs: readonly Seg[]): number {
  let total = 0;
  for (const seg of segs) total += seg.text.length;
  return total;
}

export function plainText(segs: readonly Seg[]): string {
  return segs.map((seg) => seg.text).join("");
}

/** The first `count` visible characters, run boundaries kept. */
export function sliceSegments(segs: readonly Seg[], count: number): Seg[] {
  if (count <= 0) return [];
  const out: Seg[] = [];
  let left = count;
  for (const seg of segs) {
    if (left <= 0) break;
    out.push(seg.text.length <= left ? seg : { ...seg, text: seg.text.slice(0, left) });
    left -= seg.text.length;
  }
  return out;
}

/**
 * The head of a message that fits `limit` characters. Cuts at a word where it
 * can and marks the cut with an ellipsis, so a long reply reads as the start
 * of something rather than a broken sentence.
 */
export function headOf(
  segs: readonly Seg[],
  limit: number,
): { segs: Seg[]; cut: boolean } {
  const total = visibleLength(segs);
  if (total <= limit || limit < 4) return { segs: [...segs], cut: false };
  const text = plainText(segs);
  const room = limit - 1;
  let end = room;
  const space = Math.max(text.lastIndexOf(" ", room), text.lastIndexOf("\n", room));
  // Back up to a word, but not so far that most of the room is wasted.
  if (space > room * 0.6) end = space;
  const head = sliceSegments(segs, end);
  const last = head[head.length - 1];
  if (last !== undefined) last.text = last.text.replace(/[\s,;:.\-–—]+$/u, "");
  head.push({ text: "…", code: false });
  return { segs: merge(head.filter((seg) => seg.text !== "")), cut: true };
}

/** How many lines of this width a bubble can show, as a character budget. */
export function characterBudget(
  widthPx: number,
  fontPx: number,
  lines: number,
): number {
  // Proportional UI type averages ~0.5em per character; leave slack for the
  // words that do not break where the arithmetic would like.
  const perLine = Math.max(8, Math.floor((widthPx / (fontPx * 0.52)) * 0.9));
  return perLine * lines;
}

/* ------------------------------------------------------------------ *
 * The typewriter
 * ------------------------------------------------------------------ */

const BASE_CPS = 90;
/** Whatever is left is cleared within this, so a long reply is not a wait. */
const CATCH_UP_MS = 1_400;

/**
 * Reveals a message at speaking speed. It never restarts for the same
 * message: text that grows keeps its place, so a streamed reply flows, and a
 * rewrite of the same message only pulls the cursor back if it now ends sooner.
 */
export class Typewriter {
  private id = "";
  private text = "";
  private shown = 0;
  /** Characters per second, fixed when the target is set. See `retime`. */
  private rate = BASE_CPS;

  /** Point at a message. `instant` shows it whole (a message from before you looked). */
  setTarget(id: string, text: string, instant: boolean): void {
    if (id !== this.id) {
      this.id = id;
      this.text = text;
      this.shown = instant ? text.length : 0;
      this.retime();
      return;
    }
    const grew = text.length > this.text.length;
    this.text = text;
    if (this.shown > text.length) this.shown = text.length;
    if (grew) this.retime();
  }

  /**
   * Speaking speed for what is left to say: never slower than a person talks,
   * never so slow that a long reply is a wait. It is set once per target and
   * then held — recomputing it every step from what remains would make the
   * speed fall as the text runs out and stretch the last words into a crawl.
   */
  private retime(): void {
    const left = this.text.length - this.shown;
    this.rate = Math.max(BASE_CPS, (left * 1_000) / CATCH_UP_MS);
  }

  /** Advance by `dtMs` and return how many characters are now visible. */
  step(dtMs: number): number {
    if (this.text.length - this.shown <= 0) return Math.floor(this.shown);
    this.shown = Math.min(this.text.length, this.shown + (this.rate * dtMs) / 1_000);
    return Math.floor(this.shown);
  }

  get visible(): number {
    return Math.floor(this.shown);
  }

  /** Still revealing. */
  get typing(): boolean {
    return this.visible < this.text.length;
  }

  get currentId(): string {
    return this.id;
  }
}
