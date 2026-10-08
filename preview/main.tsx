// Preview harness: the real Panel and lanes, fed by a script instead of BB.
// Build with `npm run preview`, then open preview/out/index.html — or take a
// screenshot with preview/shot.mjs. `?theme=dark` and `?view=page` switch the
// look; `?t=<ms>` is not needed, the scenario runs on its own clock.
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import "../app.css";
import { Panel } from "../stage/Panel";
import { guestBot } from "../stage/cast";
import type { LaneModel } from "../stage/model";
import type { FleetRow } from "../lib/fleet";
import type { Bot } from "../vendor/types";

const heat = (...values: number[]) => [...Array<number>(12).fill(0), ...values].slice(-12);

function row(over: Partial<FleetRow> & Pick<FleetRow, "id" | "title">): FleetRow {
  return {
    status: "active",
    model: "claude-sonnet-5-5",
    effort: "high",
    projectId: null,
    providerId: "claude-code",
    parentThreadId: null,
    childCount: 0,
    tool: null,
    verb: null,
    glyph: null,
    kind: null,
    said: null,
    settled: false,
    streaming: false,
    busy: true,
    files: [],
    heat: heat(2, 4, 6, 3, 8, 5),
    waiting: null,
    context: null,
    quietMs: 800,
    ...over,
  };
}

const bots: Record<string, Bot> = {
  architect: { id: "b1", name: "BB Architect", mainThreadId: null, avatar: { color: "#7ccf9a", shape: "round", expression: "happy", motion: "float" } },
  coach: { id: "b2", name: "Business Coach", mainThreadId: null, avatar: { color: "#f0b24a", shape: "cloud", expression: "calm", motion: "float" } },
  studio: { id: "b3", name: "Studio C", mainThreadId: null, avatar: { color: "#6aa6f0", shape: "triangle", expression: "calm", motion: "float" } },
  reminders: { id: "b4", name: "Reminders", mainThreadId: null, avatar: { color: "#f07aa8", shape: "blob", expression: "calm", motion: "float" } },
  vault: { id: "b5", name: "Vault Keeper", mainThreadId: null, avatar: { color: "#b18af0", shape: "squircle", expression: "calm", motion: "float" } },
  dusty: { id: "b6", name: "Old Faithful", mainThreadId: null, avatar: { color: "#8fd0d0", shape: "capsule", expression: "calm", motion: "float" } },
};

/** The script: what each thread is doing at second `t`. */
function scene(t: number): Array<{ bot: Bot; guest?: boolean; waiting?: boolean; helpers?: number; row: FleetRow }> {
  const lanes = [
    {
      bot: bots.architect as Bot,
      helpers: 2,
      row: row({
        id: "thr_arch",
        title: "Custom agent tv",
        tool: t < 9 ? "npm test" : "app.tsx",
        verb: t < 9 ? "Running command" : "Editing file",
        kind: t < 9 ? "commandExecution" : "fileChange",
        files: ["app.tsx", "lib/fleet.ts"],
        context: { used: 142_000, window: 200_000, fraction: 0.71, estimated: false },
        said: {
          id: t < 9 ? "m1" : "m2",
          done: true,
          text:
            t < 9
              ? "Found it. Agent TV's pump is reusable, so I'm forking it and putting a speech layer on top. Running the tests first."
              : "Tests are green. Wiring the lane animations into the sidebar peek now, then the full page.",
        },
      }),
    },
    {
      bot: bots.coach as Bot,
      waiting: true,
      row: row({
        id: "thr_coach",
        title: "Pricing proposal for Hudson Valley",
        busy: false,
        waiting: "question",
        tool: "AskUserQuestion",
        verb: "Asking",
        kind: "toolCall",
        settled: false,
        said: { id: "c1", done: true, text: "I have two pricing options ready. Which of these do you want me to put in the proposal: flat per scan, or per square foot?" },
        heat: heat(0, 0, 1, 5, 2, 0),
        quietMs: 12_000,
      }),
    },
    {
      bot: bots.studio as Bot,
      row: row({
        id: "thr_studio",
        title: "Pano viewer F drive",
        streaming: t > 4,
        tool: "Responding",
        kind: "agentMessage",
        verb: "Responding",
        said: {
          id: t < 7 ? "s1" : "s2",
          done: t < 7 || t > 9,
          text:
            t < 7
              ? "Index built:\n- 212 tours found on F:\n- 9 are missing thumbnails\n- `index.json` written to the viewer folder"
              : "Thumbnails regenerated for the 9 stragglers. I'll re-run the index and confirm the viewer loads every tour before I call this finished.",
        },
      }),
    },
    {
      bot: bots.reminders as Bot,
      row: row({
        id: "thr_rem",
        title: "Nudge about the 4pm call",
        busy: t < 3,
        status: "idle",
        tool: "bb reminders add",
        verb: "Ran command",
        kind: "commandExecution",
        settled: true,
        said: { id: "r1", done: true, text: "All set. I'll nudge you at 4pm, ten minutes before the call." },
        heat: heat(1, 3, 2, 0, 0, 0),
        quietMs: t < 3 ? 400 : 5_000,
      }),
    },
    {
      bot: bots.vault as Bot,
      row: row({
        id: "thr_vault",
        title: "Vault cleanup",
        status: "error",
        busy: false,
        tool: "sync_vault.py",
        verb: "Ran command",
        kind: "commandExecution",
        settled: true,
        said: { id: "v1", done: true, text: "The sync script exited with code 1: the vault is locked by another process." },
        heat: heat(4, 6, 1, 0, 0, 0),
        quietMs: 60_000,
      }),
    },
    {
      bot: guestBot("thr_guest", "Claude Code"),
      guest: true,
      row: row({
        id: "thr_guest",
        title: "Untitled",
        status: "idle",
        busy: false,
        said: { id: "g1", done: true, text: "Done: renamed the three config files and updated the imports." },
        heat: heat(0, 0, 0, 0, 0, 0),
        quietMs: 25 * 60_000,
      }),
    },
    {
      bot: bots.dusty as Bot,
      row: row({
        id: "thr_dusty",
        title: "Quarterly notes",
        status: "idle",
        busy: false,
        said: { id: "d1", done: true, text: "Notes filed under Q3." },
        heat: heat(0, 0, 0, 0, 0, 0),
        quietMs: 40 * 60_000,
      }),
    },
  ];
  // A lane joins late, to show the drop-in, and one leaves.
  const filtered = lanes.filter((lane) => !(lane.row.id === "thr_dusty" && t > 14));
  if (t > 11) {
    filtered.splice(2, 0, {
      bot: bots.reminders as Bot,
      helpers: 0,
      row: row({
        id: "thr_new",
        title: "Brand new thread",
        tool: "bb thread list",
        verb: "Running command",
        kind: "commandExecution",
        said: { id: "n1", done: true, text: "On it. Let me look at what is running right now." },
      }),
    } as (typeof lanes)[number]);
  }
  return filtered;
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const dark = params.get("theme") === "dark";
  const view = params.get("view") ?? "both";
  const [t, setT] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = setInterval(() => setT((performance.now() - start) / 1000), 250);
    return () => clearInterval(timer);
  }, []);
  const step = Math.floor(t);
  const lanes: LaneModel[] = useMemo(
    () =>
      scene(step).map(({ bot, guest, waiting, helpers, row: r }) => ({
        row: r,
        bot,
        guest: guest === true,
        title: r.title,
        projectName: r.id === "thr_arch" ? "BB Architect" : null,
        providerName: "Claude Code",
        badge: null,
        waiting: waiting === true,
        helpers: helpers ?? 0,
        age: r.quietMs + (t - step) * 1000,
        parentTitle: null,
      })),
    [step, t],
  );
  const [onlyWorking, setOnlyWorking] = useState(false);
  const shown = onlyWorking ? lanes.filter((lane) => lane.row.busy || lane.waiting) : lanes;
  const open = (id: string) => console.log("open", id);
  return (
    <div className="pv" data-theme={dark ? "dark" : "light"}>
      {view !== "page" ? (
        <aside className="pv-sidebar">
          <div className="bst-panel-host">
            <Panel
              lanes={shown}
              variant="compact"
              visibleLanes={Number(params.get("lanes") ?? 5)}
              onlyWorking={onlyWorking}
              onToggleWorking={() => setOnlyWorking((value) => !value)}
              onOpen={open}
              onDismiss={() => {}}
              onClose={() => {}}
              onPopout={() => {}}
            />
          </div>
        </aside>
      ) : null}
      {view !== "sidebar" ? (
        <main className="pv-main bst-page">
          <Panel
            lanes={shown}
            variant="roomy"
            title="Bot Stage"
            onlyWorking={onlyWorking}
            onToggleWorking={() => setOnlyWorking((value) => !value)}
            onOpen={open}
            onDismiss={() => {}}
          />
        </main>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
