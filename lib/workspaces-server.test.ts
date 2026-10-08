import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
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
});
