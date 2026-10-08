import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createWorkspaces } from "./workspaces-server";
import { workspaceSchema, type WorkspaceScene } from "./workspace";

const scene: WorkspaceScene = {
  name: "A first-message scene", palette: ["#142831", "#346859", "#e8c995"],
  rects: Array.from({ length: 20 }, (_, i) => [i * 5, 10 + i, 4, 6, 1 + i % 2]),
};
let host: ReturnType<typeof createFakePluginHost>;
afterEach(async () => { await host?.harness.lifecycle.dispose(); });
const context = (id: string) => makePluginAgentConfigurationContext({ thread: { id } });

describe("original conversation workspaces", () => {
  it("asks new threads to generate from only the initial message and never inherits another thread's room", async () => {
    host = createFakePluginHost({ pluginId: "bot-stage" });
    const store = createWorkspaces(host.bb);
    store.save("parent", { scene });
    const config = await host.harness.behavior.resolveAgentConfiguration(context("child"));
    expect(config.instructions).toContain("ONLY their initial message");
    expect(config.instructions).toContain("Do not select, recolor or copy");
    expect(config.tools.map(t => t.name)).toEqual(["bot_stage_workspace"]);
    expect(store.read("child")).toBeNull();
  });

  it("binds tool writes to the calling thread and persists through reload without regenerating", async () => {
    host = createFakePluginHost({ pluginId: "bot-stage" });
    createWorkspaces(host.bb);
    await host.harness.behavior.callAgentTool("bot_stage_workspace", { scene }, { threadId: "thr_a" });
    let restored: ReturnType<typeof createWorkspaces>;
    host = await host.harness.lifecycle.reload(bb => { restored = createWorkspaces(bb); });
    expect(restored!.read("thr_a")).toEqual(scene);
    expect(restored!.read("thr_b")).toBeNull();
    expect((await host.harness.behavior.resolveAgentConfiguration(context("thr_a"))).instructions).toBeNull();
    expect(restored!.save("thr_a", { scene: { ...scene, name: "Later message" } }).saved).toBe(false);
    expect(restored!.read("thr_a")?.name).toBe(scene.name);
  });

  it("rejects the same rendered room for a different thread even if renamed", () => {
    host = createFakePluginHost({ pluginId: "bot-stage" });
    const store = createWorkspaces(host.bb);
    store.save("a", { scene });
    expect(() => store.save("b", { scene: { ...scene, name: "Different name" } })).toThrow("already belongs");
    expect(store.read("b")).toBeNull();
    expect(store.save("b", { scene: { ...scene, palette: ["#172835", "#45876a", "#fdcc67"] } }).saved).toBe(true);
  });

  it("requires an explicit redraw to change saved artwork", () => {
    host = createFakePluginHost({ pluginId: "bot-stage" });
    const store = createWorkspaces(host.bb);
    store.save("a", { scene });
    const changed = { ...scene, name: "Requested redraw", rects: [...scene.rects, [0, 0, 10, 10, 2]] };
    expect(store.save("a", { scene: changed, replace: true }).saved).toBe(true);
    expect(store.read("a")).toEqual(changed);
  });

  it("rejects out-of-bounds pixels, invalid palette indexes and executable content", () => {
    host = createFakePluginHost({ pluginId: "bot-stage" });
    for (const rect of [[127, 0, 2, 1, 1], [0, 0, 1, 1, 5], [0, 0, 0, 5, 1]]) {
      expect(workspaceSchema.safeParse({ ...scene, rects: [...scene.rects, rect] }).success).toBe(false);
    }
    expect(workspaceSchema.safeParse({ ...scene, script: "alert(1)" }).success).toBe(false);
  });

  describe("drawing as soon as the first message is sent", () => {
    const spawned: any[] = [];
    const metadata: Record<string, Record<string, unknown>> = {};
    const deleted: string[] = [];
    function start(spawn?: () => Promise<unknown>) {
      spawned.length = 0;
      deleted.length = 0;
      for (const key of Object.keys(metadata)) delete metadata[key];
      host = createFakePluginHost({
        pluginId: "bot-stage",
        sdk: { threads: {
          spawn: (async (args: any) => {
            spawned.push(args);
            if (spawn) return spawn();
            metadata.thr_helper = args.pluginMetadata;
            return makeThreadResponse({ id: "thr_helper" });
          }) as never,
          getPluginMetadata: (async ({ threadId }: { threadId: string }) => metadata[threadId] ?? {}) as never,
          delete: (async ({ threadId }: { threadId: string }) => { deleted.push(threadId); return { ok: true }; }) as never,
        } },
      });
      return createWorkspaces(host.bb);
    }
    const firstMessage = (overrides: Record<string, unknown> = {}) => makeMessageDispatchHookContext({
      thread: makeThreadResponse({ id: "thr_main", status: "pending" }),
      input: { blocks: [], text: "Send a pickle pic to Miles" },
      attempt: "start-turn",
      ...overrides,
    } as never);
    const dispatch = (context: ReturnType<typeof firstMessage>) => host.harness.inspection.registrations.hooks["message.dispatch"]!(context);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    it("starts a small hidden drawing thread from the first message without holding it up", async () => {
      start();
      expect(await dispatch(firstMessage())).toEqual({ action: "proceed" });
      await settle();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toMatchObject({ visibility: "hidden", model: "claude-haiku-5-5", pluginMetadata: { drawFor: "thr_main" } });
      expect(spawned[0].prompt).toContain("Send a pickle pic to Miles");
    });

    it("draws only once per conversation, even when the dispatch pass re-runs", async () => {
      start();
      await dispatch(firstMessage());
      await dispatch(firstMessage());
      await settle();
      expect(spawned).toHaveLength(1);
    });

    it("ignores follow-ups, hidden threads and its own drawing threads", async () => {
      start();
      await dispatch(firstMessage({ attempt: "join-turn" }));
      await dispatch(firstMessage({ thread: makeThreadResponse({ id: "thr_a", status: "idle" }) }));
      await dispatch(firstMessage({ thread: makeThreadResponse({ id: "thr_b", status: "pending", visibility: "hidden" }) }));
      await dispatch(firstMessage({ thread: makeThreadResponse({ id: "thr_c", status: "pending" }), originPluginId: "bot-stage" }));
      await settle();
      expect(spawned).toHaveLength(0);
    });

    it("saves the drawing thread's scene to the conversation it was started for", async () => {
      const store = start();
      await dispatch(firstMessage());
      await settle();
      await host.harness.behavior.callAgentTool("bot_stage_workspace", { scene }, { threadId: "thr_helper" });
      expect(store.read("thr_main")).toEqual(scene);
      expect(store.read("thr_helper")).toBeNull();
    });

    it("stops asking the main agent to draw once a drawing is under way, and tells the drawing thread its job", async () => {
      start();
      await dispatch(firstMessage());
      await settle();
      expect((await host.harness.behavior.resolveAgentConfiguration(context("thr_main"))).instructions).toBeNull();
      const helper = await host.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { id: "thr_helper" }, pluginMetadata: { drawFor: "thr_main" } }));
      expect(helper.instructions).toContain("one-shot pixel-art illustrator");
    });

    it("lets the main agent draw as a fallback when the drawing thread cannot start", async () => {
      start(async () => { throw new Error("no capacity"); });
      await dispatch(firstMessage());
      await settle();
      expect((await host.harness.behavior.resolveAgentConfiguration(context("thr_main"))).instructions).toContain("ONLY their initial message");
    });

    it("tidies a drawing thread away once it goes idle", async () => {
      start();
      await dispatch(firstMessage());
      await settle();
      await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_helper" }) } as never);
      await settle();
      expect(deleted).toEqual(["thr_helper"]);
    });
  });
});
