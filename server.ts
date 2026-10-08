// bb-plugin-bot-stage — backend: the fleet pump and the bot directory.
//
// Forked from MacHatter1's Agent TV (MIT). Every lane on the stage — the call in
// flight, the files touched in the last minute, whether the model is
// mid-stream, what it last said — comes from one durable source: the thread
// event log.
//
// The pump is read-only and deliberately cheap:
//
//   1. `experimental_thread.events` says a thread's event sequence moved
//      (core coalesces that to at most once per second per thread) and hands
//      over the current thread DTO, so status and title cost no read at all.
//   2. Only then does the pump read that thread. A feed it has never read is
//      seeded from the tail of the log first (`order: desc`, one page), because
//      following an unseeded feed forward would walk the thread's whole history
//      a page at a time. After that it reads only the *new* rows, with
//      `threads.events.list` bounded by `afterSeq` + `types` + `limit`, and
//      folds them into a small feed.
//   3. Steps 1-2 run only while a viewer is watching — an open stage heartbeats
//      `stage_snapshot`. With nobody looking it stores the free status
//      announcements and issues zero reads.
//   4. Each second the feeds fold into one bounded frame, published on the
//      "stage" realtime channel and returned by `stage_snapshot`. A frame whose
//      content has not changed is not republished — the clock is not content,
//      so the stage ages its own rows between frames.
//
// What is new here: a thread whose last words are older than the tail read
// gets one bounded lookup for them (`hydrateSaid`), and `owners` answers which
// of the user's bots each thread belongs to, so a lane can be played by the
// right character.
//
// The folding itself lives in lib/fleet.ts so it is testable without a server.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { avatarSchema, rpcContract, type Bot } from "./contract";
import { createWorkspaces } from "./lib/workspaces-server";
import {
  applyRow,
  applySaidItem,
  applyThreadDto,
  applyWait,
  buildFrame,
  clip,
  emptyFeed,
  EVENT_PAGE_LIMIT,
  feedIsBusy,
  feedIsStale,
  FLEET_EVENT_TYPES,
  frameKey,
  effortOf,
  messageOf,
  modelOf,
  createWallOrder,
  textOf,
  waitLabel,
  STAGE_CHANNEL,
  MAX_ROWS,
  SEED_REQUEST_MAX,
  type Feed,
  type FleetFrame,
  type WallOrder,
  type ToolStatus,
  type WireRow,
} from "./lib/fleet";

/** Frame cadence while someone is watching. */
const TICK_MS = 1_000;
/** Nobody has watched this long => stop reading events. */
const WATCH_TTL_MS = 20_000;
/** Events per read, reads per notification, events per cold seed. */
const DRAIN_LIMIT = EVENT_PAGE_LIMIT;
const MIN_DRAIN_LIMIT = 1;
const DRAIN_ROUNDS = 3;
const SEED_LIMIT = 24;
const DRAIN_RETRY_MS = 5_000;
/**
 * The most events one drain pass can fold. A backlog bigger than this can
 * never be walked off — the thread produces new ones faster than the reader
 * retires old ones — so past this point the feed jumps to the tail instead.
 */
const CATCHUP_LIMIT = DRAIN_LIMIT * DRAIN_ROUNDS;
/** Longest wait between retries of a feed that keeps failing. */
const MAX_RETRY_MS = 60_000;
/** Consecutive failures after which a feed is left alone for good. */
const MAX_FEED_FAILURES = 5;
/** Do not re-read a stale feed's tail more often than this. */
const RESYNC_INTERVAL_MS = 5_000;
const MODEL_LOOKUP_LIMIT = 24;
const MODEL_LOOKUP_PAGES = 4;
const MODEL_EVENT_TYPES = [
  "client/turn/requested",
  "client/turn/start",
  "provider/modelFallback",
] as const;
/**
 * Finding a thread's last words: completed items, newest first. Most of them
 * are tool calls whose output can be large, so the page is small and a
 * response that is still too big gives up rather than retrying forever.
 */
const SAID_LOOKUP_LIMIT = 30;
const SAID_LOOKUP_PAGES = 3;
/** How many feeds the pump keeps at all, however quiet. */
const MAX_FEEDS = 80;

/** bots-sidebar owns the bots; this plugin only asks it who they are. */
const BOTS_PLUGIN_ID = "bots-sidebar";
/** bots_list reads every bot's state files, so a listing is reused this long. */
const LISTING_TTL_MS = 15_000;
const BOTS_RPC_TIMEOUT_MS = 20_000;
/** Deep enough for orchestrated work; a loop in parent links cannot spin forever. */
const MAX_ANCESTORS = 12;
const MAX_CACHED_PARENTS = 5_000;

// Plain z.object strips everything else bots_list returns, including each
// bot's soul and memory text, which must not travel to the frontend.
const listingSchema = z.object({
  bots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mainThreadId: z.string().nullable().optional(),
      avatar: avatarSchema,
    }),
  ),
  threadBindings: z.array(z.object({ threadId: z.string(), botId: z.string() })),
});

interface BotListing {
  bots: Map<string, Bot>;
  /** Thread id to bot id, for threads bound directly (main threads included). */
  bindings: Map<string, string>;
}

export default async function plugin(bb: BbPluginApi) {
  const workspaces = createWorkspaces(bb);
  const settings = bb.settings.define({
    maxRows: {
      type: "number",
      label: "Threads on the stage",
      description:
        "How many threads the stage carries (1-24). The sidebar peek shows " +
        "a scrolling module; the full page shows them all.",
      // Validated at the boundary rather than clamped after the fact, so an
      // out-of-range value is rejected where the user typed it.
      experimental_schema: z.number().int().min(1).max(MAX_ROWS),
      default: 10,
    },
    showQuiet: {
      type: "boolean",
      label: "Keep finished threads on the stage",
      description: "Leave a bot on stage after its thread goes quiet, asleep.",
      default: true,
    },
    peekLanes: {
      type: "number",
      label: "Lanes in the sidebar module",
      description:
        "How many bots the sidebar module and floating monitor show before scrolling (2-10), subject to available screen space.",
      experimental_schema: z.number().int().min(2).max(10),
      default: 5,
    },
  });
  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
  });

  const feeds = new Map<string, Feed>();
  /** The layout the viewer is looking at; see `buildFrame`'s `order`. */
  const wallOrder: WallOrder = createWallOrder();

  const botDirectory = createBotDirectory(bb);
  let watchUntil = 0;
  let lastFrameKey = "";
  let stopped = false;

  const watched = (): boolean => Date.now() < watchUntil;

  function maxRows(): number {
    const value = config.maxRows;
    if (typeof value !== "number" || !Number.isFinite(value)) return 10;
    return Math.max(1, Math.min(MAX_ROWS, Math.round(value)));
  }

  function feedFor(id: string, title?: string): Feed {
    let feed = feeds.get(id);
    if (feed === undefined) {
      feed = emptyFeed(id, title ?? id);
      feeds.set(id, feed);
    }
    return feed;
  }

  /**
   * Bound the pump's memory: evict the quietest feeds first, preferring to
   * keep busy ones. A fleet of more than MAX_FEEDS busy threads does lose the
   * least recently active of them.
   */
  function trimFeeds(): void {
    if (feeds.size <= MAX_FEEDS) return;
    const now = Date.now();
    const ordered = [...feeds.values()]
      .filter((feed) => !feed.draining)
      .sort(
        (left, right) =>
          // Tombstones for threads that are gone go first: they exist only to
          // stop `feedFor` resurrecting a feed we already know is unreadable.
          Number(left.dead) - Number(right.dead) === 0
            ? Number(feedIsBusy(left, now)) - Number(feedIsBusy(right, now)) ||
              left.lastAt - right.lastAt
            : Number(right.dead) - Number(left.dead),
      );
    for (const feed of ordered.slice(0, feeds.size - MAX_FEEDS)) {
      feeds.delete(feed.id);
    }
  }

  function isPayloadTooLarge(error: unknown): boolean {
    return /\b413\b|(?:payload|response).*(?:too large|exceeds)/iu.test(
      messageOf(error),
    );
  }

  /**
   * The thread is gone. Nothing will ever make this read succeed, so retrying
   * it every few seconds for the rest of the session only burns reads and
   * fills the log.
   */
  function isGone(error: unknown): boolean {
    return /\b404\b|thread[_ ]not[_ ]found|not found/iu.test(messageOf(error));
  }

  /** Note a failed read: back off, and give up once it is clearly hopeless. */
  function noteFailure(feed: Feed, what: string, error: unknown): void {
    if (isGone(error)) {
      // Kept in the map, not deleted: `feedFor` would hand the next caller a
      // brand-new feed and we would read the missing thread all over again.
      // Clearing `lastAt` is what actually removes its tile.
      feed.dead = true;
      feed.lastAt = 0;
      feed.target = feed.cursor;
      bb.log.debug(`fleet ${what} gave up on a thread that is gone: ${feed.id}`);
      return;
    }
    feed.failures += 1;
    if (feed.failures >= MAX_FEED_FAILURES) {
      feed.dead = true;
      bb.log.debug(
        `fleet ${what} failed ${feed.failures}x, leaving ${feed.id} alone: ${messageOf(error)}`,
      );
      return;
    }
    // Exponential, so a server having a bad minute is asked once a minute
    // rather than twelve times.
    feed.retryAt =
      Date.now() +
      Math.min(MAX_RETRY_MS, DRAIN_RETRY_MS * 2 ** (feed.failures - 1));
    bb.log.debug(`fleet ${what} failed: ${feed.id}: ${messageOf(error)}`);
  }

  /** A read worked: the feed is healthy again. */
  function noteSuccess(feed: Feed): void {
    feed.failures = 0;
    feed.retryAt = 0;
  }

  /**
   * Jump this feed to the tail of its log. Used for a cold start and for
   * catching up: a feed whose backlog is bigger than one drain pass can never
   * walk it off, because the thread appends faster than the reader retires.
   * Skipping loses the middle, which is exactly right for a "now" view.
   */
  async function readTail(feed: Feed): Promise<boolean> {
    if (stopped || feed.dead) return false;
    let rows: WireRow[];
    try {
      rows = (await bb.sdk.threads.events.list({
        threadId: feed.id,
        order: "desc",
        types: FLEET_EVENT_TYPES,
        limit: String(SEED_LIMIT),
      })) as unknown as WireRow[];
    } catch (error) {
      noteFailure(feed, "tail read", error);
      return false;
    }
    noteSuccess(feed);
    feed.resyncAt = Date.now() + RESYNC_INTERVAL_MS;
    if (!Array.isArray(rows) || rows.length === 0) return true;
    const stamp = Date.now();
    let newest = 0;
    for (const row of rows) {
      const seq = row.seq;
      if (typeof seq === "number" && seq > newest) newest = seq;
    }
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      applyRow(feed, rows[index] as WireRow, stamp);
    }
    feed.cursor = Math.max(feed.cursor, newest);
    feed.target = Math.max(feed.target, newest);
    return true;
  }

  /** Read this thread's new events. One read loop per thread at a time. */
  async function drain(feed: Feed): Promise<void> {
    if (feed.draining || stopped || feed.dead || feed.retryAt > Date.now()) {
      return;
    }
    feed.draining = true;
    try {
      // Too far behind to walk: take the tail and carry on from there. This is
      // the difference between a feed that recovers in one read and one that
      // shows minutes-old history for as long as its thread keeps talking.
      if (feed.target - feed.cursor > CATCHUP_LIMIT) {
        bb.log.debug(
          `fleet skipping ${feed.target - feed.cursor} unread events on ${feed.id}`,
        );
        // A page size dropped by an earlier oversized response gets a fresh
        // start here too; we are not reading that stretch of log again.
        feed.drainLimit = DRAIN_LIMIT;
        await readTail(feed);
        feed.cursor = Math.max(feed.cursor, feed.target);
        return;
      }
      let pageLimit = Math.max(
        MIN_DRAIN_LIMIT,
        Math.min(DRAIN_LIMIT, feed.drainLimit),
      );
      let round = 0;
      while (round < DRAIN_ROUNDS && feed.cursor < feed.target) {
        let rows: unknown;
        try {
          rows = await bb.sdk.threads.events.list({
            threadId: feed.id,
            afterSeq: String(feed.cursor),
            order: "asc",
            types: FLEET_EVENT_TYPES,
            limit: String(pageLimit),
          });
        } catch (error) {
          if (isPayloadTooLarge(error)) {
            if (pageLimit > MIN_DRAIN_LIMIT) {
              pageLimit = Math.max(MIN_DRAIN_LIMIT, Math.floor(pageLimit / 2));
              feed.drainLimit = pageLimit;
              bb.log.debug(
                `fleet drain response too large: ${feed.id}; retrying with ${pageLimit} rows`,
              );
              continue;
            }
            // One event that does not fit in a response of its own. Halving
            // cannot go below one, so the only way past it is past it: step
            // the cursor over that row rather than asking for it forever.
            feed.cursor += 1;
            round += 1;
            bb.log.debug(
              `fleet drain skipped an oversized event on ${feed.id} at seq ${feed.cursor}`,
            );
            continue;
          }
          noteFailure(feed, "drain", error);
          return;
        }
        round += 1;
        noteSuccess(feed);
        if (!Array.isArray(rows)) {
          noteFailure(feed, "drain", new Error("event list was not an array"));
          return;
        }
        if (rows.length === 0) {
          feed.cursor = feed.target;
          break;
        }
        const stamp = Date.now();
        let newest = feed.cursor;
        for (const row of rows) {
          const seq = row.seq;
          if (typeof seq === "number" && seq > newest) newest = seq;
        }
        for (const row of rows) applyRow(feed, row, stamp);
        if (newest <= feed.cursor) break;
        feed.cursor = newest;
        if (rows.length < pageLimit) break;
      }
    } finally {
      feed.draining = false;
    }
  }

  /** Cold-start one feed from the tail of its event log. */
  async function hydrate(feed: Feed): Promise<void> {
    if (feed.hydrated || stopped || feed.dead || feed.retryAt > Date.now()) {
      return;
    }
    feed.hydrated = true;
    // A one-off read failure used to leave a feed permanently unseeded, so a
    // failed tail read un-latches this and backs off instead.
    if (!(await readTail(feed))) {
      feed.hydrated = false;
      return;
    }
    await hydrateModel(feed);
    await hydrateSaid(feed);
  }

  /**
   * A cold seed folds only the newest handful of events, and a thread deep in
   * tool calls can have said its last words further back than that. Look for
   * them once: newest completed items first, a few small pages, stopping at the
   * first agent message. Without this a bot that has just been put on the
   * stage has nothing to say until its thread next speaks.
   */
  async function hydrateSaid(feed: Feed): Promise<void> {
    const now = Date.now();
    if (feed.said !== null) {
      feed.saidLookedUp = true;
      return;
    }
    if (feed.saidLookedUp || stopped || feed.dead || feed.saidRetryAt > now) return;
    feed.saidRetryAt = now + DRAIN_RETRY_MS;
    try {
      let beforeSeq: string | undefined;
      let limit = SAID_LOOKUP_LIMIT;
      for (let page = 0; page < SAID_LOOKUP_PAGES; page += 1) {
        let rows: WireRow[];
        try {
          rows = (await bb.sdk.threads.events.list({
            threadId: feed.id,
            order: "desc",
            limit: String(limit),
            types: ["item/completed"],
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          })) as unknown as WireRow[];
        } catch (error) {
          // A page of big command output can exceed the response ceiling.
          // Ask for fewer once; if even that is too much, there is nothing
          // sensible to say about this thread.
          if (isPayloadTooLarge(error) && limit > 6) {
            limit = 6;
            page -= 1;
            continue;
          }
          throw error;
        }
        if (!Array.isArray(rows) || rows.length === 0) break;
        let oldest = Number.POSITIVE_INFINITY;
        for (const row of rows) {
          const item = (row.data as { item?: Record<string, unknown> } | null)?.item;
          if (item !== undefined && item !== null && textOf(item.type) === "agentMessage") {
            // A live event may have set it while this read was in flight.
            if (feed.said === null) applySaidItem(feed, item, true);
            feed.saidLookedUp = true;
            return;
          }
          if (typeof row.seq === "number" && row.seq < oldest) oldest = row.seq;
        }
        if (rows.length < limit || !Number.isFinite(oldest) || oldest <= 1) break;
        beforeSeq = String(oldest);
      }
      // Looked everywhere we are willing to; this thread has said nothing yet.
      feed.saidLookedUp = true;
    } catch (error) {
      bb.log.debug(`stage said lookup failed: ${feed.id}: ${messageOf(error)}`);
    }
  }

  /**
   * The feed thinks it is caught up but its thread is running and silent.
   * Following the log forward cannot fix that — the cursor is already at the
   * end of what we were told about — so re-read the tail. Rate-limited, and
   * only for threads core says are running, so a genuinely idle fleet costs
   * nothing.
   */
  async function resyncIfStale(feed: Feed): Promise<void> {
    const now = Date.now();
    if (
      stopped ||
      feed.dead ||
      !feed.hydrated ||
      feed.draining ||
      feed.retryAt > now ||
      feed.resyncAt > now ||
      !feedIsStale(feed, now)
    ) {
      return;
    }
    bb.log.debug(
      `fleet re-reading the tail of a stale running thread: ${feed.id}`,
    );
    await readTail(feed);
  }

  /**
   * Model selection lives on the request event, not the thread DTO. A
   * filtered lookup keeps the model visible even when a busy thread's latest
   * 24 events have already pushed that request out of the cold-start tail.
   */
  async function hydrateModel(feed: Feed): Promise<void> {
    const now = Date.now();
    if (
      (feed.model !== null && feed.effort !== null) ||
      stopped ||
      feed.modelRetryAt > now
    ) {
      return;
    }
    feed.modelRetryAt = now + DRAIN_RETRY_MS;
    try {
      // Core already resolves the execution tuple for the latest turn. This is
      // the reliable path for a quiet thread whose request event is far back
      // in history, and it avoids making the wall depend on a particular
      // provider's request-event payload shape.
      const execution = await bb.sdk.threads.defaultExecutionOptions({
        threadId: feed.id,
      });
      if (execution !== null) {
        if (typeof execution.reasoningLevel === "string") {
          feed.effort = clip(execution.reasoningLevel, 32);
        }
        if (feed.model === null && typeof execution.model === "string") {
          feed.model = clip(execution.model, 120);
        }
        if (feed.model !== null && feed.effort !== null) {
          feed.modelRetryAt = 0;
          return;
        }
      }
    } catch (error) {
      bb.log.debug(`fleet execution lookup failed: ${feed.id}: ${messageOf(error)}`);
    }
    try {
      let beforeSeq: string | undefined;
      for (let page = 0; page < MODEL_LOOKUP_PAGES; page += 1) {
        const rows = (await bb.sdk.threads.events.list({
          threadId: feed.id,
          order: "desc",
          limit: String(MODEL_LOOKUP_LIMIT),
          types: MODEL_EVENT_TYPES,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })) as unknown as WireRow[];
        if (!Array.isArray(rows) || rows.length === 0) return;
        let oldest = Number.POSITIVE_INFINITY;
        for (const row of rows) {
          const effort = effortOf(row);
          if (effort !== null) feed.effort = effort;
          const model = modelOf(row);
          if (feed.model === null && model !== null) {
            feed.model = model;
          }
          if (feed.model !== null && feed.effort !== null) {
            feed.modelRetryAt = 0;
            return;
          }
          if (typeof row.seq === "number" && row.seq < oldest) {
            oldest = row.seq;
          }
        }
        if (
          rows.length < MODEL_LOOKUP_LIMIT ||
          !Number.isFinite(oldest) ||
          oldest <= 1
        ) {
          return;
        }
        beforeSeq = String(oldest);
      }
    } catch (error) {
      bb.log.debug(`fleet model lookup failed: ${feed.id}: ${messageOf(error)}`);
    }
  }

  /**
   * The wall's frame. `order` pins the layout the viewer already read: tiles
   * keep their slot, so nothing slides around under the pointer or resets a
   * scroll position while the fleet is busy.
   */
  function frame(order?: WallOrder, rows = maxRows()): FleetFrame {
    return buildFrame(feeds.values(), {
      now: Date.now(),
      maxRows: rows,
      showQuiet: config.showQuiet,
      order,
    });
  }

  /**
   * Publish at most once per tick, and never an unchanged frame. The clock is
   * deliberately excluded from the comparison: `t` and `quietMs` move on their
   * own, so including them meant this never suppressed anything. The wall ages
   * its rows locally between frames.
   */
  function publish(force = false): void {
    if (stopped) return;
    const built = frame(wallOrder);
    const key = frameKey(built);
    if (!force && key === lastFrameKey) return;
    lastFrameKey = key;
    try {
      bb.realtime.publish(STAGE_CHANNEL, built);
    } catch (error) {
      bb.log.debug(`fleet publish failed: ${messageOf(error)}`);
    }
  }

  /**
   * Seed a feed from the tail of its log, then follow it forward. Ordering
   * matters: a feed nobody has read sits at cursor 0, so draining it first
   * would walk the thread's entire history a page at a time. `hydrate` is a
   * no-op once a feed is seeded, so this is cheap to call on any path.
   */
  async function seed(feed: Feed): Promise<void> {
    try {
      await hydrate(feed);
      // A quiet feed may have no model in its first lookup (for example while
      // core is still resolving a provider). Retry it on a later heartbeat,
      // with the lookup itself enforcing a short backoff.
      if (feed.hydrated) {
        await hydrateModel(feed);
        await hydrateSaid(feed);
      }
      await drain(feed);
      // Last: a feed can only be judged stale once it has folded whatever it
      // already knew about.
      await resyncIfStale(feed);
    } catch (error) {
      bb.log.debug(`fleet seed failed: ${feed.id}: ${messageOf(error)}`);
    }
  }

  /**
   * A viewer appeared, or renewed their lease. Seed the busy thread ids the
   * sidebar named — every time, not just for the first viewer: a thread that
   * becomes busy while the wall is already open is named by a later heartbeat,
   * and it has to be seeded from its tail like any other. Only the layout is
   * first-viewer business.
   */
  async function startWatching(requested: readonly string[]): Promise<void> {
    const wanted = requested.slice(0, SEED_REQUEST_MAX);
    const firstViewer = !watched();
    watchUntil = Date.now() + WATCH_TTL_MS;
    if (firstViewer) {
      // A fresh look gets a fresh layout: busiest first, then frozen.
      wallOrder.slots.clear();
      wallOrder.first = 0;
      wallOrder.next = 0;
    }
    await Promise.all(wanted.map((id) => seed(feedFor(id))));
    publish(firstViewer);
  }

  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    const feed = feedFor(thread.id);
    applyThreadDto(feed, thread);
    if (typeof sequence === "number" && sequence > feed.target) {
      feed.target = sequence;
    }
    trimFeeds();
    if (!watched()) return; // status is free; reads are not
    // A hidden thread gets no tile, so there is nothing to read it for. Its
    // parent still counts it, and that comes off the DTO for free.
    if (feed.hidden) return;
    void seed(feed);
  });

  function noteLifecycle(
    status: ToolStatus,
    thread: Parameters<typeof applyThreadDto>[1] & { id: string },
  ): void {
    const feed = feedFor(thread.id);
    applyThreadDto(feed, { ...thread, status });
    if (status !== "active") feed.deltaAt = 0;
    // Settle the last action rather than wiping it: a tile that has gone
    // quiet should still say what it was doing.
    if (status === "idle" || status === "error") {
      if (feed.tool !== null) feed.tool = { ...feed.tool, settled: true };
    }
    trimFeeds();
    if (watched()) publish();
  }

  /**
   * A thread started waiting on a person. Free, like the lifecycle events: no
   * read, and it is the one thing on the wall the viewer has to act on. The
   * matching resolution arrives as an interaction lifecycle row in the event
   * log (see WAIT_EVENTS in lib/fleet.ts), which is also what clears this.
   */
  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    const feed = feedFor(thread.id);
    applyThreadDto(feed, thread);
    // Key on whatever id this payload carries, preferring the field the
    // event log uses so a provider that writes lifecycle rows can resolve it
    // precisely. Providers that write none are cleared by progress instead.
    const record = interaction as { interactionId?: unknown; id?: unknown };
    const id = textOf(record.interactionId) ?? textOf(record.id) ?? thread.id;
    const at = Date.now();
    applyWait(feed, id, waitLabel(interaction), true, at);
    // A thread we have never read still deserves a tile when it needs you.
    if (feed.lastAt === 0) feed.lastAt = at;
    trimFeeds();
    if (watched()) publish();
  });

  bb.events.on("thread.active", ({ thread }) => noteLifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread }) => noteLifecycle("idle", thread));
  bb.events.on("thread.failed", ({ thread }) => noteLifecycle("error", thread));
  bb.events.on("thread.unarchived", ({ thread }) => {
    feedFor(thread.id).hydrated = false;
    trimFeeds();
  });
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      feeds.delete(thread.id);
      if (watched()) publish(true);
    });
  }

  bb.rpc.register(rpcContract, {
    async workspace_save({ threadId, ...input }) {
      await bb.sdk.threads.get({ threadId });
      return workspaces.save(threadId, input);
    },
    async stage_snapshot({ threadIds }) {
      await startWatching(threadIds);
      return frame(wallOrder);
    },
    async owners({ threadIds }) {
      return { ...await botDirectory.ownersOf(threadIds), workspaces: workspaces.readMany(threadIds) };
    },
  });

  bb.background.service("stage-frame", {
    async start(signal) {
      while (!signal.aborted && !stopped) {
        await sleep(TICK_MS, signal);
        if (signal.aborted || stopped) break;
        if (!watched()) continue;
        const now = Date.now();
        for (const feed of feeds.values()) {
          if (feed.target > feed.cursor) void drain(feed);
          else if (feedIsStale(feed, now)) void resyncIfStale(feed);
        }
        trimFeeds();
        publish();
      }
    },
  });

  bb.onDispose(() => {
    stopped = true;
    feeds.clear();
  });

  bb.log.info(`Bot Stage open — room for ${maxRows()} bots`);
}

/** Abort-aware sleep — a service must resolve when its signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Which of the user's bots owns each thread, asked of bots-sidebar. A thread
 * with no binding of its own inherits from its nearest bound ancestor — the
 * rule bots-sidebar uses to file sub-conversations under a bot.
 */
function createBotDirectory(bb: BbPluginApi) {
  let listing: BotListing | null = null;
  let fetchedAt = 0;
  let inflight: Promise<void> | null = null;
  // Parent links never change once a thread exists, so they are cached for the
  // life of the plugin. Failed lookups are not cached and get retried.
  const parents = new Map<string, string | null>();

  function refresh(): Promise<void> {
    inflight ??= bb.sdk.plugins
      .callRpc({
        pluginId: BOTS_PLUGIN_ID,
        method: "bots_list",
        input: null,
        outputSchema: listingSchema,
        signal: AbortSignal.timeout(BOTS_RPC_TIMEOUT_MS),
      })
      .then(
        (next) => {
          const bots = new Map<string, Bot>();
          const bindings = new Map<string, string>();
          for (const bot of next.bots) {
            bots.set(bot.id, { id: bot.id, name: bot.name, avatar: bot.avatar });
            if (bot.mainThreadId) bindings.set(bot.mainThreadId, bot.id);
          }
          for (const binding of next.threadBindings) bindings.set(binding.threadId, binding.botId);
          listing = { bots, bindings };
          fetchedAt = Date.now();
        },
        (error: unknown) => {
          bb.log.warn(`bots-sidebar bots_list failed: ${messageOf(error)}`);
        },
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** The cached listing; stale ones are served while a refresh runs behind them. */
  async function currentListing(): Promise<BotListing | null> {
    if (listing === null) await refresh();
    else if (Date.now() - fetchedAt > LISTING_TTL_MS) void refresh();
    return listing;
  }

  async function parentOf(threadId: string): Promise<string | null> {
    const known = parents.get(threadId);
    if (known !== undefined) return known;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const parent = thread.parentThreadId ?? null;
      if (parents.size >= MAX_CACHED_PARENTS) parents.clear();
      parents.set(threadId, parent);
      return parent;
    } catch {
      return null;
    }
  }

  async function ownerOf(threadId: string, bindings: Map<string, string>): Promise<string | null> {
    let id: string | null = threadId;
    for (let depth = 0; id !== null && depth < MAX_ANCESTORS; depth += 1) {
      const bound = bindings.get(id);
      if (bound !== undefined) return bound;
      id = await parentOf(id);
    }
    return null;
  }

  return {
    async ownersOf(threadIds: readonly string[]) {
      const ids = [...new Set(threadIds)];
      const known = await currentListing();
      const owners: Record<string, string | null> = {};
      if (known === null) {
        for (const id of ids) owners[id] = null;
        return { bots: [] as Bot[], owners };
      }
      await Promise.all(
        ids.map(async (id) => {
          const botId = await ownerOf(id, known.bindings);
          // A binding to a bot that has since been deleted is no owner at all.
          owners[id] = botId !== null && known.bots.has(botId) ? botId : null;
        }),
      );
      const used = new Set(Object.values(owners).filter((botId): botId is string => botId !== null));
      return { bots: [...known.bots.values()].filter((bot) => used.has(bot.id)), owners };
    },
  };
}
