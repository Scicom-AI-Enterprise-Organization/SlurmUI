/**
 * Pure imperative scheduler that the `useVisibleInterval` hook glues to
 * React lifecycle. Extracted so the pause-on-hidden contract is unit-
 * testable without React, jsdom, or real timers.
 *
 * The scheduler ticks `fn` every `intervalMs` while visible, fires `fn`
 * once when visibility flips from hidden → visible (catch-up), and
 * stops the timer entirely while hidden. Timer + clock APIs are
 * injectable so tests drive a fake clock.
 */

export interface SchedulerDeps {
  /** ms-since-epoch. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to globalThis.setInterval / clearInterval. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface VisibleScheduler {
  /** Call once on mount when the document is visible. Fires fn() and
   * starts the timer. */
  start(): void;
  /** Call when the tab becomes hidden — stops the timer (no fires). */
  pause(): void;
  /** Call when the tab becomes visible — fires fn() once (catch-up)
   * then restarts the timer. Idempotent if already running. */
  resume(): void;
  /** Call on unmount — stops the timer cleanly. */
  stop(): void;
  /** True when the timer is currently armed. For tests + introspection. */
  isRunning(): boolean;
}

export function createVisibleScheduler(
  fn: () => void,
  intervalMs: number,
  deps: SchedulerDeps = {},
): VisibleScheduler {
  const setIntervalImpl = deps.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
  const clearIntervalImpl = deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>));
  let handle: unknown = null;

  const arm = () => {
    if (handle != null) return;
    if (intervalMs > 0) handle = setIntervalImpl(fn, intervalMs);
  };
  const disarm = () => {
    if (handle != null) { clearIntervalImpl(handle); handle = null; }
  };

  return {
    start() {
      fn();
      arm();
    },
    pause() {
      disarm();
    },
    resume() {
      // Catch-up fire so the user sees fresh data on tab return.
      fn();
      arm();
    },
    stop() {
      disarm();
    },
    isRunning() {
      return handle != null;
    },
  };
}
