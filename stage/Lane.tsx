// bb-plugin-bot-stage — one running thread, played by one bot.
//
// A lane is the bot (a small live canvas), a speech bubble with what the agent
// last said, and a line of facts underneath: what it is doing, how busy it is,
// how much room it has left. Everything here is presentation; the lane is told
// the facts and does not fetch any.
import { useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { formatAge, formatContext, heatLevels, underPressure, basename } from "../lib/fleet";
import { workOf } from "../lib/mood";
import type { Mood } from "../vendor/sprites";
import { glowOf, isGuest } from "./cast";
import { bubbleBudget, useElementWidth, usePose, useSpeech } from "./hooks";
import { ActorCanvas } from "./ActorCanvas";
import { Workspace } from "./Workspace";
import { Check, KindGlyph, Layers } from "./glyphs";
import { SIZES, type LaneModel, type Variant } from "./model";
import type { ActorInput } from "./actor";

const WORK_LABEL = {
  run: "running",
  read: "reading",
  search: "searching",
  web: "browsing",
  edit: "editing",
  tool: "working",
} as const;

/** The short word on a lane's badge for what its bot is doing. */
export function badgeFor(mood: Mood, kind: string | null, waitingFor: string | null): string {
  switch (mood) {
    case "needs":
      return waitingFor === null ? "needs you" : `needs you · ${waitingFor}`;
    case "working":
      return WORK_LABEL[workOf(kind)];
    case "thinking":
      return "thinking";
    case "talking":
      return "talking";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "sleeping":
      return "asleep";
    case "held":
      return "wheee";
    default:
      return "idle";
  }
}

function Bars({ heat, busy }: { heat: readonly number[]; busy: boolean }) {
  const levels = heatLevels(heat);
  return (
    <span className="bst-bars" data-busy={busy} aria-hidden>
      {levels.map((level, index) => (
        <i key={index} style={{ height: `${Math.max(10, Math.round(level * 100))}%` }} />
      ))}
    </span>
  );
}

/** The moods worth a word in a slim lane: the ones you may need to act on. */
const LOUD = new Set<Mood>(["needs", "failed", "done", "held"]);

export interface LaneProps {
  model: LaneModel;
  variant: Variant;
  /** Position in the list, for the staggered entrance. */
  index: number;
  /** Play the entrance (the first time the stage fills in). */
  entering: boolean;
  leaving: boolean;
  onOpen: (threadId: string, split: boolean) => void;
  onDismiss?: (threadId: string) => void;
}

export function Lane({ model, variant, index, entering, leaving, onOpen, onDismiss }: LaneProps) {
  const { row, bot } = model;
  const size = SIZES[variant];
  const bubble = useRef<HTMLDivElement>(null);
  const width = useElementWidth(bubble);
  const speech = useSpeech(row.said, bubbleBudget(width - 22, size.font, size.lines));

  const failed = row.status === "error";
  const busy = row.busy;
  const inFlight = row.tool !== null && !row.settled;
  const pose = usePose({
    waiting: model.waiting,
    failed,
    busy,
    speaking: speech.typing,
    inFlight,
    kind: row.kind,
    quietMs: model.age,
  });
  const mood: Mood = pose.mood;
  const input: ActorInput = useMemo(
    () => ({
      pose,
      quietMs: model.age,
      context: row.context === null ? null : row.context.fraction,
      helpers: model.helpers,
    }),
    [pose, model.age, row.context, model.helpers],
  );

  const hasWords = row.said !== null && row.said.text !== "";
  const mutter =
    model.waiting
      ? "Waiting for you."
      : row.tool !== null
        ? `${row.verb ?? "Working"}: ${row.tool}`
        : (row.verb ?? (busy ? "Working on it…" : "Nothing to report."));
  const context = formatContext(row.context);
  const owner = isGuest(bot) ? (model.providerName ?? "Guest") : bot.name;
  const label = `${owner}, ${badgeFor(mood, row.kind, row.waiting)}`;
  // A slim lane has no room for the detail; the facts line names the ask.
  const badgeText = variant === "compact" && mood === "needs" ? "needs you" : badgeFor(mood, row.kind, row.waiting);
  const files = variant === "roomy" ? row.files.slice(0, 3) : [];
  const style = {
    "--bot": bot.avatar.color,
    "--glow": glowOf(bot, 0.38),
    "--glow-soft": glowOf(bot, 0.16),
    "--lane-h": `${size.height}px`,
    "--lines": size.lines,
    "--font": `${size.font}px`,
    "--delay": `${index * 70}ms`,
  } as CSSProperties;

  return (
    <li
      className="bst-lane"
      data-id={row.id}
      data-variant={variant}
      data-mood={mood}
      data-busy={busy}
      data-waiting={model.waiting}
      data-failed={failed}
      data-guest={model.guest}
      data-entering={entering}
      data-leaving={leaving}
      style={style}
    >
      <Workspace scene={model.workspace ?? null} />
      <ActorCanvas
        bot={bot}
        k={size.actor.k}
        anchor={size.actor.anchor}
        width={size.actor.width}
        height={size.actor.height}
        spawnDelay={entering ? 140 + index * 110 : 0}
        input={input}
        label={label}
        onActivate={(split) => onOpen(row.id, split)}
      />

      <div className="bst-talk">
        <header className="bst-head">
          <span className="bst-name" title={owner}>
            {owner}
          </span>
          {variant === "compact" ? (
            <button
              type="button"
              className="bst-title"
              title={model.title}
              onClick={(event) => onOpen(row.id, event.shiftKey || event.metaKey)}
            >
              {model.parentTitle === null ? null : <span className="bst-project">{"↳"}</span>}
              {model.title}
            </button>
          ) : null}
          {variant === "roomy" || LOUD.has(mood) ? (
            <span className="bst-badge" data-mood={mood}>
              {badgeText}
            </span>
          ) : null}
          <span className="bst-spacer" />
          {model.helpers > 0 ? (
            <span className="bst-family" title={`${model.helpers} subagent${model.helpers === 1 ? "" : "s"} at work`}>
              <Layers />
              {model.helpers > 1 ? model.helpers : null}
            </span>
          ) : null}
          {onDismiss !== undefined && !busy && !model.waiting ? (
            <button
              type="button"
              className="bst-dismiss"
              aria-label={`Dismiss ${model.title}`}
              title="Dismiss until it works again"
              onClick={() => onDismiss(row.id)}
            >
              <Check />
            </button>
          ) : null}
        </header>

        {variant === "roomy" ? (
          <button
            type="button"
            className="bst-title"
            title={model.title}
            onClick={(event) => onOpen(row.id, event.shiftKey || event.metaKey)}
          >
            {model.parentTitle === null ? null : <span className="bst-project">{"↳ "}{model.parentTitle}</span>}
            {model.title}
            {model.projectName === null ? null : <span className="bst-project">{model.projectName}</span>}
          </button>
        ) : null}

        <div ref={bubble} className="bst-bubble-box">
          <button
            type="button"
            key={speech.id || "mutter"}
            className="bst-bubble"
            data-kind={hasWords ? "said" : "mutter"}
            data-typing={speech.typing}
            title={row.said?.text ?? mutter}
            onClick={(event) => onOpen(row.id, event.shiftKey || event.metaKey)}
          >
            {hasWords ? (
              <span className="bst-text">
                {speech.segments.map((segment, at) =>
                  segment.code ? (
                    <code key={at} className="bst-code">
                      {segment.text}
                    </code>
                  ) : (
                    <span key={at}>{segment.text}</span>
                  ),
                )}
                {speech.typing ? <i className="bst-caret" aria-hidden /> : null}
              </span>
            ) : row.said !== null && busy ? (
              <span className="bst-dots" aria-label="Writing">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <span className="bst-text bst-mutter">{mutter}</span>
            )}
          </button>
        </div>

        <footer className="bst-foot">
          <span className="bst-tool" data-busy={busy && inFlight}>
            {row.tool !== null ? (
              <>
                <KindGlyph kind={row.kind} />
                <span className="bst-tool-text">
                  {hasWords ? `${row.verb ?? "Working"}: ${row.tool}` : row.tool}
                </span>
              </>
            ) : (
              <span className="bst-tool-text">{hasWords ? (row.verb ?? "") : ""}</span>
            )}
          </span>
          {files.map((path) => (
            <span key={path} className="bst-file" title={path}>
              {basename(path)}
            </span>
          ))}
          <span className="bst-meta">
            <Bars heat={row.heat} busy={busy} />
            {context === null ? null : (
              <span className="bst-ctx" data-hot={underPressure(row)} title="Context window used">
                {context}
              </span>
            )}
            <span className="bst-age">{formatAge(model.age)}</span>
            {model.badge}
          </span>
        </footer>
      </div>
    </li>
  );
}
