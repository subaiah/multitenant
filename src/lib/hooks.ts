/**
 * Small hooks for the patterns React's compiler rules ask for: state reset when
 * a value changes (during render, not in an effect), and the current time read
 * from a shared clock rather than Date.now() in render.
 */
import { useState, useSyncExternalStore } from 'react';

const FIRST = Symbol('first render');

/**
 * True on the render where `value` differs from the last render's, so the
 * caller can reset state right there: `if (useChanged(id)) setDraft(null)`.
 * React re-renders at once with the new state, before anything is shown.
 * `onMount`: also true on the first render (to seed state from data that may
 * already be there).
 */
export function useChanged<T>(value: T, onMount = false): boolean {
  const [seen, setSeen] = useState<T | typeof FIRST>(onMount ? FIRST : value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    return true;
  }
  return false;
}

// One clock for every component that shows "time left": ticks while anything listens
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// Nothing listening yet: the time may be old, so catch up before the first read
const snapshot = () => {
  if (!timer && Date.now() - now > 30_000) now = Date.now();
  return now;
};

/** The current time in milliseconds, updated every 30 seconds */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
