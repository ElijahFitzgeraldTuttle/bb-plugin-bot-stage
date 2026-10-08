// Behaviour tests for what Bot Stage adds to the Agent TV pump, run against
// the official fake plugin host. The pump's own cost rules (no reads while
// nobody watches, bounded pages, frame budget) are Agent TV's and are covered
// by the fold's tests; what matters here is the new reads and the new RPC.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { STAGE_CHANNEL, type FleetFrame } from "./lib/fleet";
import type { Owners } from "./contract";

const T0 = Date.now() - 2_000;

type Row = {
  id: string;
  scope: { kind: "turn"; turnId: string };
  threadId: string;
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
};

function row(seq: number, type: string, data: unknown): Row {
  return {
    id: `evt_${seq}`,
    scope: { kind: "turn", turnId: "turn-1" },
    threadId: "",
    seq,
    createdAt: T0 + seq,
    type,
    data,
  };
}

function command(seq: number, id: string, text: string): Row {
  return row(seq, "item/completed", {
    item: {
      type: "commandExecution",
      id,
      command: text,
      status: "completed",
      presentation: {
        label: { pending: "Running command", completed: "Ran command" },
        icon: { glyph: "Terminal" },
        title: text,
      },
    },
  });
}

function said(seq: number, id: string, text: string): Row {
  return row(seq, "item/completed", { item: { type: "agentMessage", id, text } });
}

type ReadArgs = {
  threadId: string;
  afterSeq?: string;
  beforeSeq?: string;
  order?: "asc" | "desc";
  limit?: string;
  types?: readonly string[];
};

function logReader(rows: () => Row[], onRead?: (args: ReadArgs) => void) {
  return async (args: ReadArgs) => {
    onRead?.(args);
    const all = rows().map((entry, index) => ({ ...entry, seq: index + 1 }));
    const matching = all
      .filter((entry) => entry.seq > Number(args.afterSeq ?? "0"))
      .filter((entry) => args.beforeSeq === undefined || entry.seq < Number(args.beforeSeq))
      .filter((entry) => args.types === undefined || args.types.includes(entry.type));
    const ordered = args.order === "desc" ? [...matching].reverse() : matching;
    return ordered
      .slice(0, Number(args.limit ?? "50"))
      .map((entry) => ({ ...entry, threadId: args.threadId }));
  };
}

let host: ReturnType<typeof createFakePluginHost>;
const reads: ReadArgs[] = [];

async function load(
  rows: Row[],
  extra: Record<string, unknown> = {},
  threads: Array<Record<string, unknown>> = [],
) {
  reads.length = 0;
  host = createFakePluginHost({
    pluginId: "bot-stage",
    sdk: {
      threads: {
        events: { list: logReader(() => rows, (args) => reads.push(args)) as never },
        list: (async () => []) as never,
        ...extra,
      },
      ...(threads.length === 0 ? {} : {}),
    },
  });
  await plugin(host.bb);
  return host;
}

const frameOf = (value: unknown) => value as FleetFrame;
const snapshot = async (ids = ["thr_a"]) =>
  frameOf(await host.harness.behavior.callRpc("stage_snapshot", { threadIds: ids }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("offers a snapshot and the cast, runs one service, and has no command line", async () => {
    await load([command(1, "i1", "npm test")]);
    const { registrations } = host.harness.inspection;
    expect([...registrations.rpcMethods].sort()).toEqual(["launch_bots", "launch_create", "launch_prepare", "owners", "stage_snapshot", "workspace_save"]);
    expect(registrations.services.map((service) => service.name)).toContain("stage-frame");
    expect(registrations.cli).toBeNull();
  });
});

describe("reading", () => {
  it("reads nothing while nobody is watching", async () => {
    await load([said(1, "m1", "hello")]);
    host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_a", status: "active", updatedAt: Date.now() }),
      sequence: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveLength(0);
    expect(
      host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === STAGE_CHANNEL),
    ).toHaveLength(0);
  });

  it("puts the agent's last message and the kind of work on the lane", async () => {
    await load([
      said(1, "m1", "I'll run the tests first."),
      row(2, "item/started", {
        item: { type: "commandExecution", id: "c1", command: "npm test", status: "pending" },
      }),
    ]);
    const frame = await snapshot();
    const [lane] = frame.rows;
    expect(lane?.said).toEqual({ id: "m1", text: "I'll run the tests first.", done: true });
    expect(lane?.kind).toBe("commandExecution");
    expect(lane?.tool).toBe("npm test");
  });

  it("finds last words that are further back than the seed reads", async () => {
    const rows: Row[] = [said(1, "m1", "Plan agreed, starting now.")];
    for (let seq = 2; seq <= 45; seq += 1) rows.push(command(seq, `c${seq}`, `step ${seq}`));
    await load(rows);
    const lane = (await snapshot()).rows[0];
    // The 24-event tail is all commands, so only the dedicated lookup can
    // have found this.
    expect(lane?.said?.text).toBe("Plan agreed, starting now.");
    expect(lane?.said?.done).toBe(true);
  });

  it("looks for last words once, not on every heartbeat, when there are none", async () => {
    const rows: Row[] = [];
    for (let seq = 1; seq <= 10; seq += 1) rows.push(command(seq, `c${seq}`, `step ${seq}`));
    await load(rows);
    const lookups = () =>
      reads.filter((args) => args.types?.length === 1 && args.types[0] === "item/completed").length;
    expect((await snapshot()).rows[0]?.said).toBeNull();
    const first = lookups();
    expect(first).toBeGreaterThan(0);
    await snapshot();
    await snapshot();
    expect(lookups()).toBe(first);
  });

  it("does not trade a live message for an older one found late", async () => {
    // The lookup may land after the thread has already started speaking.
    const rows: Row[] = [said(1, "old", "From earlier.")];
    for (let seq = 2; seq <= 30; seq += 1) rows.push(command(seq, `c${seq}`, `step ${seq}`));
    rows.push(said(31, "live", "Fresh words."));
    await load(rows);
    expect((await snapshot()).rows[0]?.said?.text).toBe("Fresh words.");
  });

  it("gives up on a lookup whose pages are too big instead of retrying forever", async () => {
    const rows: Row[] = [];
    for (let seq = 1; seq <= 10; seq += 1) rows.push(command(seq, `c${seq}`, `step ${seq}`));
    host = createFakePluginHost({
      pluginId: "bot-stage",
      sdk: {
        threads: {
          events: {
            list: (async (args: ReadArgs) => {
              reads.push(args);
              if (args.types?.length === 1 && args.types[0] === "item/completed") {
                throw new Error("413 response exceeds the limit");
              }
              return logReader(() => rows)(args);
            }) as never,
          },
          list: (async () => []) as never,
        },
      },
    });
    reads.length = 0;
    await plugin(host.bb);
    const frame = await snapshot();
    expect(frame.rows[0]?.said).toBeNull();
    const lookups = reads.filter((args) => args.types?.[0] === "item/completed");
    expect(lookups.length).toBeLessThanOrEqual(3);
  });
});

describe("owners", () => {
  const listing = {
    bots: [
      {
        id: "bot_a",
        name: "BB Architect",
        mainThreadId: "thr_main",
        avatar: { color: "#7ccf9a", shape: "round", expression: "happy", motion: "float" },
        hostId: "host_1",
        order: 1,
        hiddenUntilActivity: false,
        linkedProjectIds: ["proj_work"],
        soul: "private",
        memory: "private",
      },
      {
        id: "bot_b",
        name: "Coach",
        mainThreadId: null,
        avatar: { color: "#e8b04a", shape: "cloud", expression: "calm", motion: "still" },
        hostId: "host_1",
        order: 0,
        hiddenUntilActivity: false,
        linkedProjectIds: [],
      },
      {
        id: "bot_h",
        name: "Sleeper",
        mainThreadId: null,
        avatar: { color: "#999999", shape: "blob", expression: "calm", motion: "still" },
        hostId: "host_1",
        order: 2,
        hiddenUntilActivity: true,
        linkedProjectIds: [],
      },
    ],
    personalProjectId: "proj_personal",
    projects: [{ id: "proj_work" }],
    projectOwners: [{ projectId: "proj_work", botId: "bot_a" }],
    threadBindings: [
      { threadId: "thr_bound", botId: "bot_b" },
      { threadId: "thr_orphan", botId: "bot_gone" },
    ],
  };

  const botCalls: Array<{ method: string; input: unknown }> = [];

  async function loadOwners(parents: Record<string, string | null>) {
    reads.length = 0;
    botCalls.length = 0;
    host = createFakePluginHost({
      pluginId: "bot-stage",
      sdk: {
        threads: {
          events: { list: logReader(() => []) as never },
          list: (async () => []) as never,
          get: (async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              parentThreadId: parents[threadId] ?? null,
            })) as never,
        },
        plugins: {
          callRpc: (async ({ method, input }: { method: string; input: unknown }) => {
            botCalls.push({ method, input });
            if (method === "bot_prepare") return { stateReady: true };
            if (method === "conversation_create") return { threadId: "thr_new" };
            return listing;
          }) as never,
        },
      },
    });
    await plugin(host.bb);
  }

  const owners = async (ids: string[]) =>
    (await host.harness.behavior.callRpc("owners", { threadIds: ids })) as Owners;

  it("names the bot that owns a thread directly, and a main thread", async () => {
    await loadOwners({});
    const result = await owners(["thr_main", "thr_bound"]);
    expect(result.owners).toEqual({ thr_main: "bot_a", thr_bound: "bot_b" });
  });

  it("lets a child inherit from the nearest bound ancestor", async () => {
    await loadOwners({ thr_child: "thr_mid", thr_mid: "thr_main" });
    const result = await owners(["thr_child"]);
    expect(result.owners.thr_child).toBe("bot_a");
  });

  it("leaves an unowned thread unowned", async () => {
    await loadOwners({ thr_free: null });
    const result = await owners(["thr_free"]);
    expect(result.owners.thr_free).toBeNull();
  });

  it("treats a binding to a deleted bot as no owner", async () => {
    await loadOwners({});
    expect((await owners(["thr_orphan"])).owners.thr_orphan).toBeNull();
  });

  it("returns only the bots that were asked about, without their private state", async () => {
    await loadOwners({});
    const result = await owners(["thr_bound"]);
    expect(result.bots.map((bot) => bot.id)).toEqual(["bot_b"]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("re-reads a stale listing for a thread it has no owner for, so a new thread gets its bot", async () => {
    await loadOwners({});
    expect((await owners(["thr_fresh"])).owners.thr_fresh).toBeNull();
    listing.threadBindings.push({ threadId: "thr_fresh", botId: "bot_a" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3_000);
    try {
      expect((await owners(["thr_fresh"])).owners.thr_fresh).toBe("bot_a");
    } finally {
      clock.mockRestore();
      listing.threadBindings.pop();
    }
  });

  it("survives a loop in the parent links", async () => {
    await loadOwners({ thr_x: "thr_y", thr_y: "thr_x" });
    expect((await owners(["thr_x"])).owners.thr_x).toBeNull();
  });

  describe("starting a thread", () => {
    const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method as never, input as never) as Promise<any>;

    it("lists the bots in the Bots panel's order, without hidden ones", async () => {
      await loadOwners({});
      const { bots, threads } = await call("launch_bots", {});
      expect(bots.map((bot: { id: string }) => bot.id)).toEqual(["bot_b", "bot_a"]);
      expect(JSON.stringify(bots)).not.toContain("private");
      expect(threads.bot_a).toEqual(["thr_main"]);
      expect(threads.bot_b).toEqual(["thr_bound"]);
    });

    it("starts a bot that owns a work project in that project's checkout", async () => {
      await loadOwners({});
      expect(await call("launch_prepare", { botId: "bot_a" })).toEqual({
        botId: "bot_a",
        projectId: "proj_work",
        environment: { type: "host", hostId: "host_1", workspace: { type: "unmanaged", path: null } },
      });
      expect(botCalls.map((entry) => entry.method)).toContain("bot_prepare");
    });

    it("starts a bot with no project of its own as a personal chat", async () => {
      await loadOwners({});
      expect(await call("launch_prepare", { botId: "bot_b" })).toEqual({
        botId: "bot_b",
        projectId: "proj_personal",
        environment: { type: "host", hostId: "host_1", workspace: { type: "personal" } },
      });
    });

    it("refuses a bot that does not exist", async () => {
      await loadOwners({});
      await expect(call("launch_prepare", { botId: "bot_gone" })).rejects.toThrow();
    });

    it("files the new thread under the bot through Bots Sidebar", async () => {
      await loadOwners({});
      const request = { projectId: "proj_work", model: "m" };
      expect(await call("launch_create", { botId: "bot_a", request })).toEqual({ threadId: "thr_new" });
      expect(botCalls.at(-1)).toEqual({
        method: "conversation_create",
        input: { botId: "bot_a", request, makeMain: false },
      });
    });
  });
});
