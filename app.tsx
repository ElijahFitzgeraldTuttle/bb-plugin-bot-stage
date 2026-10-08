// bb-plugin-bot-stage — frontend: the adapter between BB and the stage.
//
// Three surfaces share one stage:
//   * a persistent module between sidebar navigation and the Bots list,
//   * a floating monitor you can drag anywhere, popped out of that module,
//   * a full page, where every bot gets room.
//
// Data comes from three places and is merged here:
//   * the sidebar's own thread view (titles, "needs you") — free, and exactly
//     as fresh as bb's own sidebar;
//   * this plugin's "stage" realtime channel — the live feed the server folds
//     out of thread events while somebody is watching;
//   * the `owners` rpc — which of your bots plays each thread.
//
// Everything that draws lives in stage/, which knows nothing about BB. This
// file only turns BB's data into lane models and wires up the registrations.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useUiSize } from "./lib/ui-size";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ProviderIcon,
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalProviderIconProps,
  ExperimentalSidebarNavigationProps,
  NewThreadRequest,
  PluginProvidersState,
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Bot as WireBot, LaunchTarget, rpcContract } from "./contract";
import { EMPTY_FRAME, fleetFrameSchema, STAGE_CHANNEL, type FleetFrame, type FleetRow } from "./lib/fleet";
import { clampWithin, measurePanel, type Offset } from "./lib/popout";
import { guestBot, toStageBot } from "./stage/cast";
import type { Bot as StageBot } from "./vendor/types";
import { useNow } from "./stage/hooks";
import type { LaneModel } from "./stage/model";
import { WORKSPACE_CHANNEL, workspaceSchema, type WorkspaceScene } from "./lib/workspace";
import { Panel } from "./stage/Panel";
import type { Gaze } from "./stage/BotPixel";
import { SpawnRail, type SpawnStatus } from "./stage/SpawnRail";
import { ThreadsMenu, type ThreadItem } from "./stage/ThreadsMenu";
import "./app.css";

const PLUGIN_ID = "bot-stage";

const POPOUT_OFFSET_KEY = "bb-plugin-bot-stage:popout-offset";
const DISMISSED_KEY = "bb-plugin-bot-stage:dismissed";
const MENU_OPEN_KEY = "bb-plugin-bot-stage:threads-open";
/** Recent threads listed before the menu scrolls. */
const RECENT_MAX = 12;

/** How often an open stage renews its lease on the server's pump. */
const HEARTBEAT_MS = 10_000;
/** Sidebar threads one snapshot call asks the server to hydrate. */
const HYDRATE_MAX = 12;
/** How often the cast is refreshed, for a bot that was recoloured meanwhile. */
const CAST_REFRESH_MS = 30_000;
/** How often, and for how long, a stage re-asks while a thread still has no bot or scene. */
const NEW_THREAD_REFRESH_MS = 3_000;
const NEW_THREAD_WINDOW_MS = 120_000;

type ProviderEntry = PluginProvidersState["providers"][number];
type ProviderRecord = ExperimentalProviderIconProps["provider"];
const ProviderIcon = experimental_ProviderIcon;

/* ------------------------------------------------------------------ *
 * Small shared stores: pop-out state, the live-only filter, dismissals
 * ------------------------------------------------------------------ */

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const popoutStore = createStore(false);
const workingOnlyStore = createStore(false);

function readDismissed(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const stored: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64)
        : [],
    );
  } catch {
    return new Set();
  }
}

const dismissedStore = createStore<ReadonlySet<string>>(
  typeof window === "undefined" ? new Set() : readDismissed(),
);

function writeDismissed(ids: ReadonlySet<string>): void {
  dismissedStore.set(ids);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage blocked: the dismissal lasts until the page reloads.
  }
}

const dismiss = (id: string) => {
  if (!dismissedStore.get().has(id)) writeDismissed(new Set(dismissedStore.get()).add(id));
};

const restore = (id: string) => {
  if (!dismissedStore.get().has(id)) return;
  const next = new Set(dismissedStore.get());
  next.delete(id);
  writeDismissed(next);
};

function readStored<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

const menuOpenStore = createStore<boolean>(typeof window === "undefined" ? false : readStored(MENU_OPEN_KEY, (raw) => raw === true, false));

const toggleMenu = () => {
  menuOpenStore.set(!menuOpenStore.get());
  writeStored(MENU_OPEN_KEY, menuOpenStore.get());
};

function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/** Sidebar signals that a thread has work the stage should keep watching. */
function looksBusy(thread: PluginSidebarThread): boolean {
  if (thread.isArchived) return false;
  if (thread.hasPendingInteraction) return true;
  const { workflows, backgroundAgents, backgroundCommands, planMode, goals } = thread.activity;
  if (workflows + backgroundAgents + backgroundCommands + planMode + goals > 0) return true;
  return (
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft" ||
    thread.indicator === "background-agent" ||
    thread.indicator === "background-command" ||
    thread.indicator === "workflow" ||
    thread.indicator === "plan-mode" ||
    thread.indicator === "goal"
  );
}

/** Threads worth reading events for, most recently touched first. */
function hydrateIds(threads: readonly PluginSidebarThread[]): string[] {
  return threads
    .filter(looksBusy)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, HYDRATE_MAX)
    .map((thread) => thread.id);
}

function useStageFeed(
  threads: readonly PluginSidebarThread[],
  currentThreadId: string | null,
): { frame: FleetFrame; stale: boolean; receivedAt: number } {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [frame, setFrame] = useState<FleetFrame>(EMPTY_FRAME);
  // When this frame arrived, on *this* clock. The pump publishes only when a
  // frame's content changes, so rows are aged locally between frames — and
  // measuring the gap here keeps us out of any server clock skew.
  const [receivedAt, setReceivedAt] = useState(0);
  const [stale, setStale] = useState(false);
  const wanted = useMemo(() => {
    const ids = hydrateIds(threads);
    // The route's own thread may not have reached the sidebar cache yet.
    if (typeof currentThreadId === "string" && currentThreadId.length > 0 && !ids.includes(currentThreadId)) {
      if (ids.length >= HYDRATE_MAX) ids[HYDRATE_MAX - 1] = currentThreadId;
      else ids.push(currentThreadId);
    }
    return ids;
  }, [currentThreadId, threads]);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const lastRoute = useRef<string | null>(currentThreadId);
  const routeSeen = useRef(false);
  const connectedOnce = useRef(false);

  const accept = useCallback((next: FleetFrame) => {
    setFrame(next);
    setReceivedAt(Date.now());
    setStale(false);
  }, []);

  const refresh = useCallback(() => {
    void rpc
      .call("stage_snapshot", { threadIds: wantedRef.current })
      .then(accept)
      .catch(() => setStale(true));
  }, [accept, rpc]);

  // Moving to another chat should not wait for the next heartbeat to seed it.
  useEffect(() => {
    if (!routeSeen.current) {
      routeSeen.current = true;
      lastRoute.current = currentThreadId;
      return;
    }
    if (lastRoute.current === currentThreadId) return;
    lastRoute.current = currentThreadId;
    refresh();
  }, [currentThreadId, refresh]);

  // The server publishes a frame whenever one changes; a snapshot on mount
  // primes it, and the heartbeat renews the lease that lets the pump read.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useRealtime(
    STAGE_CHANNEL,
    useCallback(
      (payload: unknown) => {
        const parsed = fleetFrameSchema.safeParse(payload);
        if (parsed.success) accept(parsed.data); // a malformed frame is not news
      },
      [accept],
    ),
  );

  // Signals are ephemeral and never replayed: reconcile when the socket returns.
  useEffect(() => {
    if (connection !== "connected") {
      connectedOnce.current = false;
      return;
    }
    if (connectedOnce.current) refresh();
    else connectedOnce.current = true;
  }, [connection, refresh]);

  return { frame, stale, receivedAt };
}

interface Cast {
  bots: ReadonlyMap<string, WireBot>;
  owners: Readonly<Record<string, string | null>>;
  workspaces: Readonly<Record<string, WorkspaceScene | null>>;
}

const NO_CAST: Cast = { bots: new Map(), owners: {}, workspaces: {} };

/** Which of the user's bots plays each thread on the stage. */
function useCast(rows: readonly FleetRow[]): Cast {
  const rpc = useRpc<typeof rpcContract>();
  const [cast, setCast] = useState<Cast>(NO_CAST);
  const workspaceRevision = useRef(0);
  const ids = useMemo(() => rows.map((row) => row.id).sort(), [rows]);
  const key = ids.join(",");

  useRealtime(WORKSPACE_CHANNEL, useCallback((payload: unknown) => {
    if (!payload || typeof payload !== "object" || !("threadId" in payload) || !("scene" in payload)) return;
    const { threadId, scene } = payload;
    // A thread can be drawn before the frame lists it; keep the scene for when it does.
    if (typeof threadId !== "string") return;
    const parsed = workspaceSchema.safeParse(scene);
    if (parsed.success) {
      workspaceRevision.current += 1;
      setCast(previous => ({ ...previous, workspaces: { ...previous.workspaces, [threadId]: parsed.data } }));
    }
  }, []));

  useEffect(() => {
    if (key === "") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const next = (answered: boolean, settled: boolean) => {
      if (!live) return;
      // A new thread has no bot or scene for its first moments; look again quickly
      // until both arrive, then settle into the slow refresh.
      const fast = !settled && answered && Date.now() - startedAt < NEW_THREAD_WINDOW_MS;
      timer = setTimeout(ask, fast ? NEW_THREAD_REFRESH_MS : CAST_REFRESH_MS);
    };
    const ask = () => {
      const revision = workspaceRevision.current;
      const asked = key.split(",");
      rpc.call("owners", { threadIds: asked }).then(
        (answer) => {
          if (!live) return;
          setCast((previous) => {
            const bots = new Map(previous.bots);
            for (const bot of answer.bots) bots.set(bot.id, bot);
            return { bots, owners: { ...previous.owners, ...answer.owners },
              // An older in-flight lookup must not undo a freshly drawn scene.
              workspaces: revision === workspaceRevision.current
                ? { ...previous.workspaces, ...answer.workspaces } : previous.workspaces };
          });
          const workspaces = answer.workspaces ?? {};
          next(true, asked.every((id) => answer.owners[id] != null && workspaces[id] != null));
        },
        () => {
          // A failed lookup keeps the cast it has; lanes fall back to guests.
          next(false, true);
        },
      );
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, rpc]);

  return cast;
}

/**
 * Subagents at work under a thread. The sidebar knows its visible children;
 * orchestrated workers are hidden from it, but the frame still counts them,
 * and they are running whenever their parent is.
 */
function helpersOf(row: FleetRow, threads: readonly PluginSidebarThread[]): number {
  const visible = threads.filter((thread) => thread.parentThreadId === row.id && looksBusy(thread)).length;
  return visible > 0 ? visible : row.busy ? row.childCount : 0;
}

/** Everything the lanes need that is not in the frame itself. */
function useLanes(
  frame: FleetFrame,
  receivedAt: number,
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  onlyWorking: boolean,
): { lanes: LaneModel[]; known: number } {
  const { providers } = experimental_useProviders();
  const dismissed = useStore(dismissedStore);
  const cast = useCast(frame.rows);

  // A bot that starts working again comes back from being dismissed.
  useEffect(() => {
    for (const row of frame.rows) if (row.busy) restore(row.id);
  }, [frame.rows]);

  const visible = useMemo(
    () => frame.rows.filter((row) => row.busy || row.waiting !== null || !dismissed.has(row.id)),
    [frame.rows, dismissed],
  );
  // The clock only ticks while there is something on stage to age.
  const now = useNow(visible.length > 0);
  const sinceFrame = Math.max(0, now - receivedAt);

  const lanes = useMemo(() => {
    const byId = new Map<string, PluginSidebarThread>();
    for (const thread of threads) byId.set(thread.id, thread);
    const providerById = new Map<string, ProviderEntry>();
    for (const provider of providers) providerById.set(provider.id, provider);
    const projectById = new Map<string, PluginSidebarProject>();
    for (const project of projects) projectById.set(project.id, project);
    const titleOf = (id: string): string => {
      const thread = byId.get(id);
      return thread === undefined ? id : (thread.title ?? thread.titleFallback ?? id);
    };

    const built: LaneModel[] = [];
    for (const row of visible) {
      const thread = byId.get(row.id);
      const providerId = thread?.providerId ?? row.providerId ?? null;
      const provider: ProviderRecord | null =
        providerId === null ? null : (providerById.get(providerId) ?? { id: providerId });
      const providerName = providerId === null ? null : (providerById.get(providerId)?.displayName ?? providerId);
      const projectId = thread?.projectId ?? row.projectId ?? null;
      const project = projectId === null ? undefined : projectById.get(projectId);
      const ownerId = cast.owners[row.id] ?? null;
      const owner = ownerId === null ? undefined : cast.bots.get(ownerId);
      const parentId = thread?.parentThreadId ?? row.parentThreadId ?? null;
      const waiting = row.waiting !== null || thread?.hasPendingInteraction === true;
      if (onlyWorking && !row.busy && !waiting) continue;
      built.push({
        row,
        bot: owner === undefined ? guestBot(row.id, providerName) : toStageBot(owner),
        guest: owner === undefined,
        title: thread?.title ?? thread?.titleFallback ?? row.title,
        workspace: cast.workspaces[row.id] ?? null,
        pinned: thread?.isPinned === true,
        projectName: project === undefined || project.isPersonal ? null : project.name,
        providerName,
        badge:
          provider === null ? null : (
            <ProviderIcon
              providerKind="agent"
              provider={provider}
              fallback="Bot"
              aria-label={providerName ?? "agent"}
              className="size-3 shrink-0 opacity-70"
            />
          ),
        waiting,
        helpers: helpersOf(row, threads),
        age: row.quietMs + sinceFrame,
        parentTitle: parentId === null ? null : titleOf(parentId),
      });
    }
    return built;
  }, [visible, threads, providers, projects, cast, sinceFrame, onlyWorking]);

  return { lanes, known: visible.length };
}

/* ------------------------------------------------------------------ *
 * The stage in its three places
 * ------------------------------------------------------------------ */

type PanelFrameProps = {
  variant: "compact" | "roomy";
  title?: string;
  floating?: boolean;
  onClose?: () => void;
  onPopout?: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onNudge?: (event: ReactKeyboardEvent<HTMLElement>) => void;
};

function peekLanes(values: Record<string, string | number | boolean> | undefined): number {
  const value = values?.peekLanes;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(2, Math.min(10, Math.round(value))) : 5;
}

interface Roster {
  bots: readonly WireBot[];
  /** Bot id to the threads filed directly under it. */
  filed: Readonly<Record<string, readonly string[]>>;
}

const NO_ROSTER: Roster = { bots: [], filed: {} };

/** The user's bots and which threads belong to them, kept fresh. */
function useRoster(): Roster {
  const rpc = useRpc<typeof rpcContract>();
  const [roster, setRoster] = useState<Roster>(NO_ROSTER);
  useEffect(() => {
    let live = true;
    const load = () => {
      rpc.call("launch_bots", {}).then(
        (answer) => {
          if (live) setRoster({ bots: answer.bots, filed: answer.threads });
        },
        () => undefined, // keep the roster it has
      );
    };
    load();
    const timer = setInterval(load, CAST_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [rpc]);
  return roster;
}

/** The point the text cursor is at inside `box`, or null when it is not in there. */
function caretPoint(box: HTMLElement): { x: number; y: number } | null {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  if (selection === null || selection === undefined || selection.rangeCount === 0 || !node || !box.contains(node)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
  if (last !== undefined && (last.width > 0 || last.height > 0)) return { x: last.right, y: last.top + last.height / 2 };
  // A collapsed caret has no box of its own; measure the character before it.
  if (node.nodeType === Node.TEXT_NODE && selection.anchorOffset > 0) {
    range.setStart(node, selection.anchorOffset - 1);
    range.setEnd(node, selection.anchorOffset);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return { x: rect.right, y: rect.top + rect.height / 2 };
  }
  const element = node instanceof Element ? node : node.parentElement;
  const rect = element?.getBoundingClientRect();
  return rect === undefined ? null : { x: rect.left, y: rect.top + Math.min(rect.height, 20) / 2 };
}

/** One block of look in each direction once the cursor is this far (px) from the bot. */
const GAZE_DEAD_ZONE = 40;
const lookStep = (distance: number): -1 | 0 | 1 => (distance > GAZE_DEAD_ZONE ? 1 : distance < -GAZE_DEAD_ZONE ? -1 : 0);

/**
 * Where the bot you are writing to is looking: at your text cursor as you type,
 * or down at the composer while there is no cursor in it yet.
 */
function useTypingGaze(active: boolean): Gaze {
  const [gaze, setGaze] = useState<Gaze>({ x: 0, y: 1 });
  useEffect(() => {
    if (!active) {
      setGaze({ x: 0, y: 1 });
      return;
    }
    const aim = () => {
      const icon = document.querySelector<HTMLElement>('.bst-rail-bot[aria-pressed="true"]');
      const box = document.querySelector<HTMLElement>(".bst-compose");
      if (icon === null || box === null) return;
      const from = icon.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const at = caretPoint(box) ?? { x: boxRect.left + 24, y: boxRect.top + boxRect.height / 2 };
      const next: Gaze = {
        x: lookStep(at.x - (from.left + from.width / 2)),
        y: lookStep(at.y - (from.top + from.height / 2)),
      };
      setGaze((previous) => (previous.x === next.x && previous.y === next.y ? previous : next));
    };
    aim();
    const events = ["input", "keyup", "pointerup", "focusin"] as const;
    document.addEventListener("selectionchange", aim);
    for (const name of events) document.addEventListener(name, aim, true);
    // The composer mounts a moment after it is picked, and wraps as it fills.
    const timer = setInterval(aim, 400);
    return () => {
      document.removeEventListener("selectionchange", aim);
      for (const name of events) document.removeEventListener(name, aim, true);
      clearInterval(timer);
    };
  }, [active]);
  return gaze;
}

/** The rail of bots to start a thread with, and the composer for the picked one. */
function Spawn({ lanes, threads, roster }: { lanes: readonly LaneModel[]; threads: readonly PluginSidebarThread[]; roster: Roster }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const actions = experimental_useSidebarThreadActions();
  const { bots, filed } = roster;
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [target, setTarget] = useState<LaunchTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const submitting = useRef(false);

  const status = useMemo(() => {
    const out: Record<string, SpawnStatus> = {};
    for (const lane of lanes) {
      if (lane.guest) continue;
      if (lane.waiting) out[lane.bot.id] = "needs";
      else if (lane.row.busy && out[lane.bot.id] === undefined) out[lane.bot.id] = "live";
    }
    return out;
  }, [lanes]);

  // Where a click goes: the bot's most recently touched thread that still exists.
  const lastThread = useMemo(() => {
    const live = new Map<string, number>();
    for (const thread of threads) if (!thread.isArchived) live.set(thread.id, thread.updatedAt);
    const out = new Map<string, string>();
    for (const [botId, ids] of Object.entries(filed)) {
      let best: string | null = null;
      for (const id of ids) {
        const at = live.get(id);
        if (at !== undefined && (best === null || at > (live.get(best) ?? 0))) best = id;
      }
      if (best !== null) out.set(botId, best);
    }
    return out;
  }, [threads, filed]);
  const hasThread = useMemo(() => new Set(lastThread.keys()), [lastThread]);

  const open = (botId: string) => {
    const id = lastThread.get(botId);
    if (id !== undefined) actions.open(id);
  };

  const pick = (botId: string) => {
    if (botId === pickedId) {
      setPickedId(null);
      setTarget(null);
      return;
    }
    setPickedId(botId);
    setTarget(null);
    setError(null);
    rpc.call("launch_prepare", { botId }).then(
      (next) => {
        setTarget(next);
        setFocus((value) => value + 1);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const picked = bots.find((bot) => bot.id === pickedId);
  const gaze = useTypingGaze(picked !== undefined);
  return (
    <SpawnRail bots={bots} pickedId={pickedId} status={status} hasThread={hasThread} onOpen={open} onNew={pick} gaze={gaze}>
      {picked === undefined ? null : (
        <div className="bst-compose">
          <div className="bst-compose-to">
            Message <b>{picked.name}</b>
            <button type="button" className="bst-icon" aria-label="Close composer" onClick={() => pick(picked.id)}>
              ×
            </button>
          </div>
          {target === null ? (
            error === null ? <p className="bst-compose-note">Getting {picked.name} ready…</p> : null
          ) : (
            <NewThreadComposer
              defaultProjectId={target.projectId}
              defaultEnvironment={target.environment as NewThreadRequest["environment"]}
              defaultProviderId="claude-code"
              defaultModel="claude-sonnet-5-5"
              defaultReasoningLevel="high"
              defaultPermissionMode="full"
              layout="document"
              focusRequest={focus}
              draftKey={`bot-stage:launch:${picked.id}:${target.projectId}`}
              onSubmit={async (request) => {
                if (submitting.current) throw new Error("A thread is already being created.");
                submitting.current = true;
                setError(null);
                try {
                  const { threadId } = await rpc.call("launch_create", { botId: picked.id, request: { ...request } });
                  setPickedId(null);
                  setTarget(null);
                  navigate.toThread(threadId);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                  throw cause;
                } finally {
                  submitting.current = false;
                }
              }}
            />
          )}
          {error === null ? null : (
            <p role="alert" className="bst-compose-note" data-bad>
              {error}
            </p>
          )}
        </div>
      )}
    </SpawnRail>
  );
}

/** Pinned and recent threads, as a drop-down under the stage. */
function Threads({ threads, roster, currentThreadId }: { threads: readonly PluginSidebarThread[]; roster: Roster; currentThreadId: string | null }) {
  const actions = experimental_useSidebarThreadActions();
  const open = useStore(menuOpenStore);
  const now = useNow(open);

  const items = useMemo(() => {
    const botOf = new Map<string, StageBot>();
    for (const bot of roster.bots) for (const id of roster.filed[bot.id] ?? []) botOf.set(id, toStageBot(bot));
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    // A sub-thread belongs to whoever owns its nearest bound ancestor.
    const ownerOf = (thread: PluginSidebarThread): StageBot | null => {
      let at: PluginSidebarThread | undefined = thread;
      for (let depth = 0; at !== undefined && depth < 12; depth += 1) {
        const bot = botOf.get(at.id);
        if (bot !== undefined) return bot;
        at = at.parentThreadId === null ? undefined : byId.get(at.parentThreadId);
      }
      return null;
    };
    const itemOf = (thread: PluginSidebarThread): ThreadItem => ({
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? "Untitled thread",
      bot: ownerOf(thread),
      ageMs: Math.max(0, now - thread.updatedAt),
      pinned: thread.isPinned,
      state: thread.hasPendingInteraction ? "needs" : looksBusy(thread) ? "live" : null,
    });
    const pinned = threads
      .filter((thread) => thread.isPinned && !thread.isArchived)
      .sort((left, right) => (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0))
      .map(itemOf);
    const recent = threads
      .filter((thread) => !thread.isArchived && thread.parentThreadId === null && !thread.isPinned)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, RECENT_MAX)
      .map(itemOf);
    return { pinned, recent };
  }, [threads, roster, now]);

  return (
    <ThreadsMenu
      open={open}
      onToggle={toggleMenu}
      pinned={items.pinned}
      recent={items.recent}
      currentId={currentThreadId}
      onOpen={(id, split) => actions.open(id, { split })}
      onTogglePin={(id, pinned) => void actions.setPinned(id, pinned)}
    />
  );
}

function LiveStage({ variant, title, floating, onClose, onPopout, onDragStart, onNudge }: PanelFrameProps) {
  const settings = useSettings();
  const { threads, projects } = experimental_useSidebarThreads();
  const { threadId: currentThreadId } = useBbContext();
  const actions = experimental_useSidebarThreadActions();
  const { frame, stale, receivedAt } = useStageFeed(threads, currentThreadId);
  const onlyWorking = useStore(workingOnlyStore);
  const { lanes } = useLanes(frame, receivedAt, threads, projects, onlyWorking);
  const roster = useRoster();
  return (
    <Panel
      lanes={lanes}
      variant={variant}
      visibleLanes={peekLanes(settings.values)}
      title={title}
      floating={floating}
      stale={stale}
      onlyWorking={onlyWorking}
      onToggleWorking={() => workingOnlyStore.set(!workingOnlyStore.get())}
      onOpen={(id, split) => actions.open(id, { split })}
      onDismiss={dismiss}
      onTogglePin={(id, pinned) => void actions.setPinned(id, pinned)}
      onClose={onClose}
      onPopout={onPopout}
      onDragStart={onDragStart}
      onNudge={onNudge}
      spawn={<Spawn lanes={lanes} threads={threads} roster={roster} />}
      threadsMenu={<Threads threads={threads} roster={roster} currentThreadId={currentThreadId} />}
    />
  );
}

/** The Bots Sidebar's list, which the bot strip replaces, unless it was asked to stay. */
function HideBotsPanel() {
  const settings = useSettings();
  if (settings.values?.hideBotsPanel === false) return null;
  // The list sits in a scroll box that fills the space above the sidebar footer.
  // Keep the box, so the footer stays at the bottom, but strip it of its look.
  return (
    <style>
      {".bots-sidebar { display: none !important; } *:has(> .contents > .bots-sidebar:only-child) { background: transparent !important; border-color: transparent !important; box-shadow: none !important; backdrop-filter: none !important; }"}
    </style>
  );
}

function StageSidebar({ experimental_Original: Original }: ExperimentalSidebarNavigationProps) {
  return (
    <>
      <HideBotsPanel />
      <Original />
      <section className="bst-sidebar-module" aria-label="Bot Stage" data-testid="bot-stage-sidebar">
        <LiveStage variant="compact" onPopout={() => popoutStore.set(true)} />
      </section>
    </>
  );
}

function StagePage() {
  return (
    <div className="bst-page" data-testid="bot-stage-page">
      <LiveStage variant="roomy" title="Bot Stage" />
    </div>
  );
}

/** A live count beside the page's sidebar row, so you can see it from anywhere. */
function SidebarAccessory() {
  const { threads } = experimental_useSidebarThreads();
  const working = threads.filter(looksBusy);
  const waiting = working.filter((thread) => thread.hasPendingInteraction).length;
  if (working.length === 0) return null;
  return (
    <span
      className="bst-accessory"
      data-needs={waiting > 0}
      title={`${working.length} working${waiting > 0 ? `, ${waiting} waiting on you` : ""}`}
    >
      {working.length}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The floating monitor
 * ------------------------------------------------------------------ */

function clampToPanel(element: HTMLElement | null, x: number, y: number): Offset {
  if (element === null) return { x, y };
  const box = measurePanel(element);
  return box === null ? { x, y } : clampWithin(box, x, y);
}

function readOffset(): Offset {
  try {
    const raw = window.localStorage.getItem(POPOUT_OFFSET_KEY);
    if (raw === null) return { x: 0, y: 0 };
    const stored = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (
      typeof stored.x !== "number" ||
      typeof stored.y !== "number" ||
      !Number.isFinite(stored.x) ||
      !Number.isFinite(stored.y)
    ) {
      return { x: 0, y: 0 };
    }
    // Nothing is mounted yet to measure against; the effect on open clamps it.
    return { x: stored.x, y: stored.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

function writeOffset(offset: Offset): void {
  try {
    window.localStorage.setItem(POPOUT_OFFSET_KEY, JSON.stringify(offset));
  } catch {
    // Storage blocked: the monitor just forgets where it was next time.
  }
}

type DragState = { startX: number; startY: number; originX: number; originY: number };

/** App-wide draggable monitor, opened from the sidebar module's pop-out button. */
function PopoutStage() {
  const workspace = useUiSize("workspace");
  const details = useUiSize("details");
  const open = useStore(popoutStore);
  const [offset, setOffset] = useState<Offset>(readOffset);
  const panel = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  // The pointer handlers are registered once, so they read the live offset
  // from here rather than closing over a stale render's copy.
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const onDragStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      drag.current = { startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y };
      event.preventDefault();
    },
    [offset.x, offset.y],
  );

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const active = drag.current;
      if (active === null) return;
      setOffset(
        clampToPanel(
          panel.current,
          active.originX + event.clientX - active.startX,
          active.originY + event.clientY - active.startY,
        ),
      );
    };
    const end = (): void => {
      if (drag.current === null) return;
      drag.current = null;
      writeOffset(offsetRef.current); // once, on release, not per move
    };
    // A window that shrinks must not strand the panel off-screen.
    const resize = (): void => setOffset((current) => clampToPanel(panel.current, current.x, current.y));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const onNudge = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const delta =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (delta === null) return;
    event.preventDefault();
    const next = clampToPanel(panel.current, offsetRef.current.x + delta.x, offsetRef.current.y + delta.y);
    setOffset(next);
    writeOffset(next);
  }, []);

  // A restored offset was measured against whatever window it was saved in,
  // and the panel's height changes as bots come and go: re-clamp once it is up
  // and whenever its geometry changes, so its title bar never leaves the screen.
  useEffect(() => {
    if (!open) return;
    const reclamp = (): void => {
      setOffset((current) => {
        const next = clampToPanel(panel.current, current.x, current.y);
        if (next.x === current.x && next.y === current.y) return current;
        writeOffset(next);
        return next;
      });
    };
    reclamp();
    const element = panel.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reclamp);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") popoutStore.set(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={panel}
      data-testid="bot-stage-popout"
      role="dialog"
      aria-label="Bot Stage popout"
      className="bst-popout"
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`, "--bst-panel-width": `${132 * workspace / 100 + 248 * details / 100}px` } as CSSProperties}
    >
      <LiveStage
        variant="compact"
        floating
        onClose={() => popoutStore.set(false)}
        onDragStart={onDragStart}
        onNudge={onNudge}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_sidebarNavigation({
    id: "navigation",
    title: "Bot Stage",
    description: "Standard navigation with a persistent Bot Stage module above the thread list.",
    component: StageSidebar,
  });
  app.slots.experimental_appOverlay({
    id: "peek-and-popout",
    component: PopoutStage,
  });
  app.slots.navPanel({
    id: "stage",
    title: "Bot Stage",
    icon: "Bot",
    path: "stage",
    component: StagePage,
    experimental_sidebarAccessory: SidebarAccessory,
  });
});
