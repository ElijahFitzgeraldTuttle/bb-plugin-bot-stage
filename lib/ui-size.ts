import { useSyncExternalStore } from "react";

const PREFIX = "bb-plugin-bot-stage:";
const CHANGE = `${PREFIX}size-change`;
export type UiSizeKind = "workspace" | "details";
export const UI_SIZE_MIN = 75;
export const UI_SIZE_MAX = 150;
export const UI_SIZE_STEP = 5;
const temporary: Partial<Record<UiSizeKind, number>> = {};

function normalize(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(UI_SIZE_MIN, Math.min(UI_SIZE_MAX, Math.round(value / UI_SIZE_STEP) * UI_SIZE_STEP));
}

function read(kind: UiSizeKind): number {
  if (temporary[kind] !== undefined) return temporary[kind];
  try {
    const value = window.localStorage.getItem(`${PREFIX}${kind}-size`);
    return value === null ? 100 : normalize(Number(value));
  } catch {
    return 100;
  }
}

export function setUiSize(kind: UiSizeKind, value: number): void {
  const size = normalize(value);
  try {
    window.localStorage.setItem(`${PREFIX}${kind}-size`, String(size));
    delete temporary[kind];
  } catch {
    temporary[kind] = size;
  }
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(notify: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === `${PREFIX}workspace-size` || event.key === `${PREFIX}details-size`) {
      delete temporary.workspace;
      delete temporary.details;
      notify();
    }
  };
  window.addEventListener(CHANGE, notify);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGE, notify);
    window.removeEventListener("storage", storage);
  };
}

export function useUiSize(kind: UiSizeKind): number {
  return useSyncExternalStore(subscribe, () => read(kind), () => 100);
}
