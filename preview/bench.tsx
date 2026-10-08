// Frame-cost benchmark: N lanes on stage, timed for a few seconds. Run with
// `npm run preview`, then read #result from preview/out/bench.html. In headless
// Edge there is no GPU, so this over-reports paint cost and is a ceiling.
import { createRoot } from "react-dom/client";
import { useMemo } from "react";
import "../app.css";
import { Stage } from "../stage/Stage";
import { guestBot } from "../stage/cast";
import { isThrottled } from "../stage/engine";
import type { LaneModel } from "../stage/model";
import type { FleetRow } from "../lib/fleet";

const params = new URLSearchParams(location.search);
const COUNT = Number(params.get("n") ?? 12);
const SECONDS = Number(params.get("s") ?? 8);
const KINDS = ["commandExecution", "fileRead", "search", "fileChange", "webFetch", "toolCall"];

function lane(index: number): LaneModel {
  const busy = index % 3 !== 2;
  const row: FleetRow = {
    id: `thr_${index}`,
    title: `Thread ${index}`,
    status: busy ? "active" : "idle",
    model: null,
    effort: null,
    projectId: null,
    providerId: null,
    parentThreadId: null,
    childCount: index % 4 === 0 ? 2 : 0,
    tool: busy ? "doing a thing" : null,
    verb: busy ? "Working" : null,
    glyph: null,
    kind: KINDS[index % KINDS.length] as string,
    said: { id: `m${index}`, text: "A reply that is long enough to wrap onto a few lines of the bubble.", done: true },
    settled: !busy,
    streaming: false,
    busy,
    files: [],
    heat: [0, 1, 2, 4, 3, 5, 2, 1, 6, 4, 3, 5],
    waiting: index % 7 === 6 ? "question" : null,
    context: index % 5 === 0 ? { used: 150_000, window: 200_000, fraction: 0.75, estimated: false } : null,
    quietMs: busy ? 500 : 600_000,
  };
  return {
    row,
    bot: guestBot(row.id, "Bench"),
    guest: true,
    title: row.title,
    projectName: null,
    providerName: null,
    badge: null,
    waiting: row.waiting !== null,
    helpers: row.childCount,
    age: row.quietMs,
    parentTitle: null,
  };
}

const times: number[] = [];
const rawRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) =>
  rawRaf((now) => {
    const started = performance.now();
    callback(now);
    times.push(performance.now() - started);
  });

function Bench() {
  const lanes = useMemo(() => Array.from({ length: COUNT }, (_, index) => lane(index)), []);
  return (
    <div className="bst-panel" style={{ width: 340 }}>
      <Stage lanes={lanes} variant="compact" onOpen={() => {}} style={{ height: 4000 }} />
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Bench />);

const startedAt = performance.now();
setTimeout(() => {
  // Skip the first second: it is the entrance, and the entrance is not steady state.
  const steady = times.slice(Math.floor(times.length / SECONDS));
  steady.sort((a, b) => a - b);
  const mean = steady.reduce((sum, value) => sum + value, 0) / Math.max(1, steady.length);
  const pick = (q: number) => steady[Math.min(steady.length - 1, Math.floor(steady.length * q))] ?? 0;
  const seconds = (performance.now() - startedAt) / 1000;
  const result = {
    lanes: COUNT,
    frames: times.length,
    fps: Math.round(times.length / seconds),
    meanMs: Number(mean.toFixed(2)),
    p95Ms: Number(pick(0.95).toFixed(2)),
    maxMs: Number((steady[steady.length - 1] ?? 0).toFixed(2)),
    throttled: isThrottled(),
  };
  const out = document.createElement("pre");
  out.id = "result";
  out.textContent = JSON.stringify(result);
  document.body.appendChild(out);
}, SECONDS * 1000);
