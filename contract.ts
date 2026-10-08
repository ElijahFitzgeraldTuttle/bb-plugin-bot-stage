// Wire contract between server.ts and the stage (app.tsx imports only types
// from here, so none of this ships in the frontend bundle).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { fleetFrameSchema, SEED_REQUEST_MAX } from "./lib/fleet";
import { workspaceSchema, workspaceSaveSchema } from "./lib/workspace";

/** What a bot looks like, as bots-sidebar stores it. */
export const avatarSchema = z.object({
  color: z.string(),
  shape: z.string(),
  expression: z.string(),
  motion: z.string(),
});

export const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: avatarSchema,
});

export const ownersSchema = z.object({
  /** Only the bots that own at least one of the asked-about threads. */
  bots: z.array(botSchema),
  /** Thread id to owning bot id, or null when no bot owns it. */
  owners: z.record(z.string(), z.string().nullable()),
  workspaces: z.record(z.string(), workspaceSchema.nullable()).optional(),
});

/** Where a new thread with one bot starts: its owned project, else personal. */
export const launchTargetSchema = z.object({
  botId: z.string(),
  projectId: z.string(),
  /** A NewThreadRequest["environment"]; the composer validates it, not us. */
  environment: z.record(z.string(), z.json()),
});

export const rpcContract = defineRpcContract({
  workspace_save: {
    input: workspaceSaveSchema.extend({ threadId: z.string().min(1).max(64) }),
    output: z.object({ saved: z.boolean(), message: z.string() }),
  },
  /**
   * The current frame. Calling it is also the viewer's heartbeat: it renews the
   * lease that lets the pump read thread events at all, and names the threads
   * the sidebar thinks are busy so they can be seeded straight away.
   */
  stage_snapshot: {
    input: z
      .object({
        threadIds: z.array(z.string().max(64)).max(SEED_REQUEST_MAX).default([]),
      })
      .strict(),
    output: fleetFrameSchema,
  },
  /** The bots a new thread can be started with, in the Bots panel's order. */
  launch_bots: {
    input: z.object({}).strict(),
    output: z.object({
      bots: z.array(botSchema),
      /** Bot id to the threads filed under it (its main thread included). */
      threads: z.record(z.string(), z.array(z.string())),
    }),
  },
  /** Prepare a bot's private state and say where its new thread should start. */
  launch_prepare: {
    input: z.object({ botId: z.string().min(1).max(100) }).strict(),
    output: launchTargetSchema,
  },
  /** Create the thread from the composer's request, filed under the bot. */
  launch_create: {
    input: z.object({ botId: z.string().min(1).max(100), request: z.record(z.string(), z.json()) }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  /** Which bot owns each thread, and what it looks like. */
  owners: {
    input: z.object({ threadIds: z.array(z.string().min(1).max(64)).max(100) }),
    output: ownersSchema,
  },
});

export type LaunchTarget = z.infer<typeof launchTargetSchema>;
export type Bot = z.infer<typeof botSchema>;
export type BotAvatar = z.infer<typeof avatarSchema>;
export type Owners = z.infer<typeof ownersSchema>;
