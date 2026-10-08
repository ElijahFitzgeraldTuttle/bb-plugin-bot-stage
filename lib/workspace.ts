import { z } from "zod";

export const WORKSPACE_CHANNEL = "workspaces";
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Original pixel geometry, authored by the conversation's agent. No templates. */
export const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  palette: z.array(color).min(3).max(24),
  // Palette 0 fills the background. Each subsequent rectangle is x,y,w,h,color index.
  rects: z.array(z.array(z.number().int().min(0).max(128)).length(5)).min(20).max(256),
}).strict().superRefine((scene, ctx) => {
  scene.rects.forEach(([x, y, w, h, ink], i) => {
    if (w < 1 || h < 1 || x + w > 128 || y + h > 128 || ink >= scene.palette.length) {
      ctx.addIssue({ code: "custom", path: ["rects", i], message: "Rectangle must fit 128×128 and reference an existing palette color." });
    }
  });
});

export const workspaceSaveSchema = z.object({
  scene: workspaceSchema,
  replace: z.boolean().default(false).describe("Only true when the user explicitly asks to redraw this thread's workspace."),
}).strict();

export type WorkspaceScene = z.infer<typeof workspaceSchema>;
