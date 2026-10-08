import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { WORKSPACE_CHANNEL, workspaceSaveSchema, workspaceSchema, type WorkspaceScene } from "./workspace";

const TOOL = "bot_stage_workspace";
const INSTRUCTIONS = `This conversation has no Bot Stage workspace yet. The user wants one original 128×128 pixel-art workspace per conversation, generated from scratch using ONLY their initial message in this thread as the creative brief. Do not base it on the auto-title, later messages, replies, bot identity or project defaults.
At the start of the first turn, call bot_stage_workspace once, alongside your normal work and before your final answer. Author the complete scene yourself from that initial user message: a coherent small space with three recognizable, bespoke objects representing it. For an existing conversation missing its scene, read its initial user message first. Do not select, recolor or copy a stock/preset room; vary architecture, placement, objects and palette to fit this specific opening message. Do not use thread-ID hashing or generic random scenery. No need for an image service, extra agent or user question.
Supply scene {name,palette,rects}. palette is 3–24 #rrggbb colors; palette[0] fills the entire 128×128 background. rects are 20–256 arrays [x,y,width,height,paletteIndex], drawn in order, with integer coordinates inside 128×128. Aim for 60–130 well-composed rectangles, crisp pixel details and restrained contrast. Draw the entire environment and original objects, not a bot: the existing animated bot is overlaid at lower-left. Keep x=8..65,y=78..126 relatively clear for it; put taller objects above or to the right. Do not add status labels, emoji, words, private details or controls to the artwork. This is a decorative side action; do not narrate it or change the user's task. The scene is saved to this thread and must not be redrawn on later turns unless the user asks. If a previous call reports it already exists, keep it.`;

export function createWorkspaces(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_scenes (
    thread_id TEXT PRIMARY KEY, scene TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`);
  const get = db.prepare("SELECT scene FROM workspace_scenes WHERE thread_id = ?");
  const put = db.prepare(`INSERT INTO workspace_scenes(thread_id, scene, digest, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET scene=excluded.scene, digest=excluded.digest`);
  const duplicate = db.prepare("SELECT thread_id FROM workspace_scenes WHERE digest = ? AND thread_id != ?");

  function read(id: string): WorkspaceScene | null {
    const row = get.get(id) as { scene: string } | undefined;
    if (!row) return null;
    try {
      const parsed = workspaceSchema.safeParse(JSON.parse(row.scene));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  function save(id: string, input: unknown) {
    const { scene, replace } = workspaceSaveSchema.parse(input);
    if (!replace && read(id)) return { saved: false, message: "This thread already has its own workspace. Kept the existing art." };
    // Compare the rendered pixels, not names, palette order or rectangle order.
    const pixels = new Uint8Array(128 * 128 * 3);
    const colors = scene.palette.map(c => [1, 3, 5].map(at => Number.parseInt(c.slice(at, at + 2), 16)));
    for (let at = 0; at < pixels.length; at += 3) pixels.set(colors[0], at);
    for (const [x, y, w, h, ink] of scene.rects) {
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) pixels.set(colors[ink], (py * 128 + px) * 3);
    }
    const digest = createHash("sha256").update(pixels).digest("hex");
    if (duplicate.get(digest, id)) throw new Error("This artwork already belongs to another thread. Draw a new scene from this conversation instead of reusing it.");
    put.run(id, JSON.stringify(scene), digest, Date.now());
    bb.realtime.publish(WORKSPACE_CHANNEL, { threadId: id, scene });
    return { saved: true, message: "Original 128×128 workspace saved for this conversation." };
  }

  bb.agents.registerTool({
    name: TOOL,
    description: "Save this conversation's original 128×128 pixel-art workspace. Draw its entire palette and rectangle geometry from the conversation, without templates. Persisted once per thread.",
    parameters: workspaceSaveSchema,
    presentation: { label: { pending: "Drawing conversation workspace", completed: "Drew conversation workspace" }, icon: { glyph: "Palette" }, suppress: true },
    execute(input, ctx) {
      if (ctx.signal.aborted) throw new Error("Workspace save cancelled.");
      const result = save(ctx.threadId, input);
      return { content: [{ type: "text", text: result.message }] };
    },
  });
  bb.agents.configure(ctx => ({ tools: [TOOL], skills: [], instructions: read(ctx.thread.id) ? undefined : INSTRUCTIONS }));

  return { read, save, readMany: (ids: string[]) => Object.fromEntries(ids.map(id => [id, read(id)])) };
}
