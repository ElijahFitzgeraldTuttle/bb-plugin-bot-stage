// @vitest-environment jsdom
// The stage's frontend contract: what it asks the server for, who it casts in
// each lane, what it shows from a frame, and what a click does. Canvas drawing
// is the one thing jsdom cannot do; the lane has to read correctly without it,
// which is also the fallback for a machine with no 2d canvas.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FleetFrame, FleetRow } from "../lib/fleet";
import type { Owners } from "../contract";

function thread(over: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_a",
    projectId: "proj_1",
    title: "Fix the flaky test",
    titleFallback: null,
    displayTitle: "Fix the flaky test",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "active",
    runtimeStatus: "active",
    queuedWork: "none",
    href: "/threads/thr_a",
    isHidden: false,
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "runtime",
    indicatorLabel: "Thread is running",
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 2,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...over,
  };
}

function project(over: Partial<PluginSidebarProject> = {}): PluginSidebarProject {
  return {
    id: "proj_1",
    name: "Echo Depths",
    isPersonal: false,
    href: "/projects/proj_1",
    settingsHref: "/projects/proj_1/settings",
    ...over,
  };
}

function laneRow(over: Partial<FleetRow> = {}): FleetRow {
  return {
    id: "thr_a",
    status: "active",
    title: "Fix the flaky test",
    model: "gpt-5.6-luna",
    effort: "max",
    projectId: "proj_1",
    providerId: "codex",
    parentThreadId: null,
    childCount: 0,
    tool: "git commit -m 'fix: the flaky one'",
    verb: "Running command",
    glyph: "Terminal",
    kind: "commandExecution",
    said: { id: "m1", text: "Found the race. Fixing it now.", done: true },
    settled: false,
    streaming: false,
    busy: true,
    files: ["/repo/src/app.tsx"],
    heat: [0, 0, 1, 2, 5, 1, 0, 3, 4, 2, 1, 6],
    waiting: null,
    context: null,
    quietMs: 1_200,
    ...over,
  };
}

const frameOf = (...rows: FleetRow[]): FleetFrame => ({ t: Date.now(), rows });
const FRAME = frameOf(laneRow());

const OWNERS: Owners = {
  bots: [
    {
      id: "bot_arch",
      name: "BB Architect",
      avatar: { color: "#7ccf9a", shape: "round", expression: "happy", motion: "float" },
    },
  ],
  owners: { thr_a: "bot_arch" },
};

let app: Awaited<ReturnType<typeof loadPluginApp>>;
const mounted: Array<{ lifecycle: { unmount: () => void } }> = [];

beforeAll(async () => {
  // jsdom has no 2d canvas. A lane must still read without its bot.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  app = await loadPluginApp(() => import("../app"));
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    // Whether the popout is open is module state; Escape is its public way out.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // So is the live-only filter. Release it the way a user would.
    for (const pressed of Array.from(document.querySelectorAll('[aria-pressed="true"]'))) {
      (pressed as HTMLElement).click();
    }
  });
  for (const slot of mounted.splice(0)) {
    try {
      slot.lifecycle.unmount();
    } catch {
      // Already unmounted by the test itself.
    }
  }
});

type Options = Parameters<typeof renderSlot>[2];

function peek(options: Options) {
  const item = app.experimentalSidebarFooterItems.find(
    (candidate) => candidate.id === "stage" && candidate.kind === "disclosure",
  );
  if (item === undefined || item.kind !== "disclosure") throw new Error("Bot Stage registered no footer disclosure");
  const slot = renderSlot({ component: item.component }, { dismiss: () => {} }, options);
  mounted.push(slot);
  return slot;
}

function page(options: Options) {
  const panel = app.navPanels.find((candidate) => candidate.id === "stage");
  if (panel === undefined) throw new Error("Bot Stage registered no page");
  const slot = renderSlot({ component: panel.component }, { subPath: "" }, options);
  mounted.push(slot);
  return slot;
}

function overlay(options: Options) {
  const item = app.appOverlays.find((candidate) => candidate.id === "peek-and-popout");
  if (item === undefined) throw new Error("Bot Stage registered no app overlay");
  const slot = renderSlot({ component: item.component }, {}, options);
  mounted.push(slot);
  return slot;
}

const rpc = (frame: FleetFrame = FRAME, owners: Owners = OWNERS) => ({
  stage_snapshot: () => frame,
  owners: () => owners,
});

const ready = (threads: PluginSidebarThread[] = [thread()], projects = [project()]) => ({
  status: "ready" as const,
  threads,
  projects,
});

describe("registrations", () => {
  it("adds a footer disclosure, a page, and one app-wide overlay", () => {
    const [item] = app.experimentalSidebarFooterItems;
    expect(item?.kind).toBe("disclosure");
    expect(item?.label).toContain("Bot Stage");
    expect(item?.icon).toBe("Bot");
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["stage"]);
    expect(app.appOverlays.map((entry) => entry.id)).toEqual(["peek-and-popout"]);
  });
});

describe("a lane", () => {
  it("is played by the bot that owns the thread, and says what the agent said", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    expect(await slot.findByText("BB Architect")).toBeTruthy();
    expect(slot.getByText("Fix the flaky test")).toBeTruthy();
    // A message that was said before you looked is simply there, not retyped.
    expect(slot.getByText("Found the race. Fixing it now.")).toBeTruthy();
    expect(slot.getByText("ON AIR")).toBeTruthy();
    expect(slot.getByRole("img", { name: /BB Architect/ })).toBeTruthy();
  });

  it("falls back to a guest named for the agent when no bot owns the thread", async () => {
    const slot = peek({
      rpc: rpc(FRAME, { bots: [], owners: { thr_a: null } }),
      sidebarThreads: ready(),
    });
    // Without a providers roster the guest is named for the raw provider id.
    expect(await slot.findByText("codex")).toBeTruthy();
    expect(slot.queryByText("BB Architect")).toBeNull();
  });

  it("still draws a lane while the cast has not arrived", async () => {
    const slot = peek({
      rpc: {
        stage_snapshot: () => FRAME,
        owners: () => new Promise<Owners>(() => {}),
      },
      sidebarThreads: ready(),
    });
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
  });

  it("shows what the agent is doing in the facts line", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    expect(slot.getByText(/Running command: git commit/)).toBeTruthy();
  });

  it("says it needs you, and puts the lamp on", async () => {
    const waiting = frameOf(laneRow({ busy: false, waiting: "question", said: { id: "q1", text: "Which one?", done: true } }));
    const slot = peek({ rpc: rpc(waiting), sidebarThreads: ready() });
    expect(await slot.findByText("Which one?")).toBeTruthy();
    expect(slot.getByText("NEEDS YOU")).toBeTruthy();
    // The sidebar can know before the event log does.
    expect(slot.getByRole("img", { name: /needs you/i })).toBeTruthy();
  });

  it("believes the sidebar when it says a thread is waiting", async () => {
    const quiet = frameOf(laneRow({ busy: false, waiting: null }));
    const slot = peek({
      rpc: rpc(quiet),
      sidebarThreads: ready([thread({ hasPendingInteraction: true })]),
    });
    await slot.findByText("Fix the flaky test");
    expect(slot.getByText("NEEDS YOU")).toBeTruthy();
  });
});

describe("what it asks the server for", () => {
  it("seeds the threads that look busy and not the quiet ones", async () => {
    const slot = peek({
      rpc: rpc(),
      sidebarThreads: ready([
        thread({ id: "thr_a" }),
        thread({ id: "thr_done", indicator: "none", updatedAt: 1 }),
        thread({ id: "thr_arch", isArchived: true, indicator: "runtime" }),
      ]),
    });
    await slot.findByText("Fix the flaky test");
    const snapshots = slot.inspection.rpcCalls.filter((call) => call.method === "stage_snapshot");
    expect(snapshots[0]?.input).toEqual({ threadIds: ["thr_a"] });
  });

  it("keeps the thread you are looking at in the seed set", async () => {
    const slot = peek({
      context: { projectId: "proj_1", threadId: "thr_here" },
      rpc: rpc(),
      sidebarThreads: ready([]),
    });
    await slot.findByText("Fix the flaky test");
    const snapshots = slot.inspection.rpcCalls.filter((call) => call.method === "stage_snapshot");
    expect(snapshots[0]?.input).toEqual({ threadIds: ["thr_here"] });
  });

  it("asks who owns the threads on stage", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("BB Architect");
    const asked = slot.inspection.rpcCalls.find((call) => call.method === "owners");
    expect(asked?.input).toEqual({ threadIds: ["thr_a"] });
  });
});

describe("the live feed", () => {
  it("keeps an ungenerated room empty and applies only that thread's generated artwork", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    const room = document.querySelector('.bst-lane[data-id="thr_a"] .bst-workspace')!;
    expect(room.getAttribute("data-state")).toBe("pending");
    const scene = { name: "Original", palette: ["#122333", "#456789", "#fedcba"],
      rects: Array.from({ length: 20 }, (_, i) => [i * 5, 20, 4, 8, 1]) };
    await slot.behavior.emitRealtime("workspaces", { threadId: "someone_else", scene });
    expect(room.getAttribute("data-state")).toBe("pending");
    await slot.behavior.emitRealtime("workspaces", { threadId: "thr_a", scene });
    expect(room.getAttribute("data-state")).toBe("ready");
    await slot.behavior.emitRealtime("stage", frameOf(laneRow({ title: "A changed title" })));
    expect(room.getAttribute("data-state")).toBe("ready");
    expect(slot.getByText("Found the race. Fixing it now.")).toBeTruthy();
  });

  it("follows the realtime channel without another request", async () => {
    const slot = peek({
      rpc: rpc(frameOf()),
      sidebarThreads: ready(),
    });
    expect(await slot.findByText(/The stage is empty/)).toBeTruthy();
    await slot.behavior.emitRealtime("stage", FRAME);
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
  });

  it("ignores a frame that is not a frame", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    await slot.behavior.emitRealtime("stage", { rows: "not a frame" });
    await slot.behavior.emitRealtime("stage", { t: 1, rows: [{ id: "x" }] });
    expect(slot.getByText("Fix the flaky test")).toBeTruthy();
  });

  it("types out a new message instead of dropping it in", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Found the race. Fixing it now.");
    const next = "All green. Pushing the fix to the branch for review.";
    await slot.behavior.emitRealtime(
      "stage",
      frameOf(laneRow({ said: { id: "m2", text: next, done: true } })),
    );
    // The new bubble starts empty and fills in; it does not arrive whole.
    expect(slot.queryByText(next)).toBeNull();
    expect(await slot.findByText(next, {}, { timeout: 3_000 })).toBeTruthy();
  });

  it("keeps typing the same message as it grows rather than starting over", async () => {
    const slot = peek({
      rpc: rpc(frameOf(laneRow({ said: { id: "m9", text: "Reading", done: false } }))),
      sidebarThreads: ready(),
    });
    await slot.findByText("Reading");
    await slot.behavior.emitRealtime(
      "stage",
      frameOf(laneRow({ said: { id: "m9", text: "Reading the whole log now.", done: false } })),
    );
    expect(await slot.findByText("Reading the whole log now.", {}, { timeout: 3_000 })).toBeTruthy();
  });
});

describe("clicking", () => {
  it("opens the thread through the host, and beside the stage on shift", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    const title = await slot.findByText("Fix the flaky test");
    const button = title.closest("button") as HTMLElement;
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toEqual([
        { method: "open", threadId: "thr_a", options: { split: false } },
      ]),
    );
    fireEvent.click(button, { shiftKey: true });
    await vi.waitFor(() =>
      expect(slot.inspection.sidebarActionCalls.at(-1)).toEqual({
        method: "open",
        threadId: "thr_a",
        options: { split: true },
      }),
    );
  });

  it("opens the thread when you click what it said", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    const words = await slot.findByText("Found the race. Fixing it now.");
    fireEvent.click(words.closest("button") as HTMLElement);
    await vi.waitFor(() => expect(slot.inspection.sidebarActionCalls).toHaveLength(1));
  });
});

describe("quiet bots", () => {
  const quiet = frameOf(laneRow({ busy: false, status: "idle", tool: null, verb: null, quietMs: 600_000 }));

  it("can be dismissed, and are remembered as dismissed", async () => {
    const slot = peek({ rpc: rpc(quiet), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    fireEvent.click(slot.getByRole("button", { name: /Dismiss Fix the flaky test/ }));
    await vi.waitFor(() => expect(slot.queryByText("Fix the flaky test")).toBeNull(), { timeout: 2_000 });
    expect(JSON.parse(window.localStorage.getItem("bb-plugin-bot-stage:dismissed") ?? "[]")).toEqual(["thr_a"]);
  });

  it("do not get a dismiss button while they are working", async () => {
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    expect(slot.queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });

  it("come back when the thread works again", async () => {
    window.localStorage.setItem("bb-plugin-bot-stage:dismissed", JSON.stringify(["thr_a"]));
    const slot = peek({ rpc: rpc(quiet), sidebarThreads: ready() });
    await vi.waitFor(() => expect(slot.queryByText("Fix the flaky test")).toBeNull());
    await slot.behavior.emitRealtime("stage", FRAME);
    expect(await slot.findByText("Fix the flaky test")).toBeTruthy();
  });

  it("can be filtered away so only live bots remain", async () => {
    const mixed = frameOf(
      laneRow(),
      laneRow({ id: "thr_b", title: "Old news", busy: false, status: "idle", quietMs: 900_000 }),
    );
    const slot = peek({ rpc: rpc(mixed), sidebarThreads: ready([thread(), thread({ id: "thr_b", title: "Old news" })]) });
    await slot.findByText("Old news");
    fireEvent.click(slot.getByRole("button", { pressed: false, name: /working/ }));
    await vi.waitFor(() => expect(slot.queryByText("Old news")).toBeNull(), { timeout: 2_000 });
    expect(slot.getByText("Fix the flaky test")).toBeTruthy();
  });
});

describe("UI size", () => {
  it("adjusts workspace and details independently across views and restores both on remount", async () => {
    const compact = peek({ rpc: rpc(), sidebarThreads: ready() });
    const roomy = page({ rpc: rpc(), sidebarThreads: ready() });
    const controls = within(compact.container);
    fireEvent.click(controls.getByRole("button", { name: "Bot Stage options" }));
    fireEvent.change(controls.getByRole("slider", { name: "Workspace size" }), { target: { value: "125" } });
    expect((controls.getByRole("slider", { name: "Details size" }) as HTMLInputElement).value).toBe("100");
    fireEvent.change(controls.getByRole("slider", { name: "Details size" }), { target: { value: "85" } });
    expect(window.localStorage.getItem("bb-plugin-bot-stage:workspace-size")).toBe("125");
    expect(window.localStorage.getItem("bb-plugin-bot-stage:details-size")).toBe("85");
    for (const view of [compact, roomy]) {
      const panel = view.container.querySelector(".bst-panel") as HTMLElement;
      expect(panel.style.getPropertyValue("--bst-workspace-scale")).toBe("1.25");
      expect(panel.style.getPropertyValue("--bst-details-scale")).toBe("0.85");
    }
    compact.lifecycle.unmount();
    roomy.lifecycle.unmount();
    const restored = peek({ rpc: rpc(), sidebarThreads: ready() });
    const restoredControls = within(restored.container);
    fireEvent.click(restoredControls.getByRole("button", { name: "Bot Stage options" }));
    expect((restoredControls.getByRole("slider", { name: "Workspace size" }) as HTMLInputElement).value).toBe("125");
    expect((restoredControls.getByRole("slider", { name: "Details size" }) as HTMLInputElement).value).toBe("85");
    fireEvent.click(restoredControls.getByRole("button", { name: "Reset sizes" }));
    expect(window.localStorage.getItem("bb-plugin-bot-stage:workspace-size")).toBe("100");
    expect(window.localStorage.getItem("bb-plugin-bot-stage:details-size")).toBe("100");
  });

  it.each([["invalid", "1"], ["500", "1.5"], ["0", "0.75"]])("handles stored size %s", (stored, scale) => {
    window.localStorage.setItem("bb-plugin-bot-stage:workspace-size", stored);
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    expect((slot.container.querySelector(".bst-panel") as HTMLElement).style.getPropertyValue("--bst-workspace-scale")).toBe(scale);
  });

  it("keeps slider controls from dragging or closing the floating monitor", async () => {
    const popout = overlay({ rpc: rpc(), sidebarThreads: ready() });
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    fireEvent.click(within(slot.container).getByRole("button", { name: "Pop out Bot Stage" }));
    const floating = await popout.findByTestId("bot-stage-popout");
    const controls = within(floating);
    fireEvent.click(controls.getByRole("button", { name: "Bot Stage options" }));
    const slider = controls.getByRole("slider", { name: "Workspace size" });
    const before = floating.style.transform;
    fireEvent.pointerDown(slider, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(floating.style.transform).toBe(before);
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(controls.queryByRole("slider")).toBeNull();
    expect(popout.queryByTestId("bot-stage-popout")).not.toBeNull();
    expect(document.activeElement).toBe(controls.getByRole("button", { name: "Bot Stage options" }));
  });
});

describe("the page", () => {
  it("gives every bot a roomy lane, with the project it belongs to", async () => {
    const slot = page({ rpc: rpc(), sidebarThreads: ready() });
    expect(await slot.findByText("BB Architect")).toBeTruthy();
    expect(slot.getByText("Echo Depths")).toBeTruthy();
    expect(slot.getByText("running")).toBeTruthy();
    expect(slot.container.querySelector('[data-variant="roomy"]')).not.toBeNull();
  });
});

describe("the floating monitor", () => {
  it("opens from the peek's pop-out button and closes on Escape", async () => {
    const popout = overlay({ rpc: rpc(), sidebarThreads: ready() });
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    expect(popout.queryByTestId("bot-stage-popout")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Pop out Bot Stage" }));
    expect(await popout.findByTestId("bot-stage-popout")).toBeTruthy();
    const floating = await popout.findByTestId("bot-stage-popout");
    expect(await within(floating).findByText("Fix the flaky test")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await vi.waitFor(() => expect(popout.queryByTestId("bot-stage-popout")).toBeNull());
  });

  it("remembers where it was left", async () => {
    window.localStorage.setItem("bb-plugin-bot-stage:popout-offset", JSON.stringify({ x: 12, y: -8 }));
    const popout = overlay({ rpc: rpc(), sidebarThreads: ready() });
    const slot = peek({ rpc: rpc(), sidebarThreads: ready() });
    await slot.findByText("Fix the flaky test");
    fireEvent.click(slot.getByRole("button", { name: "Pop out Bot Stage" }));
    const panel = await popout.findByTestId("bot-stage-popout");
    expect(panel.style.transform).toContain("12px");
  });
});
