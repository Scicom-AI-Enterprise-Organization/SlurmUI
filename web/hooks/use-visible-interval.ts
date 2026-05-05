"use client";

import { useEffect, useRef } from "react";
import { createVisibleScheduler } from "@/lib/visible-interval-scheduler";

/**
 * setInterval that pauses while the tab is hidden and fires `fn`
 * immediately when the tab becomes visible again.
 *
 * The vanilla `setInterval(fn, ms)` keeps ticking while the user is on
 * a different tab — wasting backend cycles on /resources SSH probes
 * that no human is reading. Page Visibility API lets us fire only when
 * the page is visible, then catch up the moment the user comes back.
 *
 * The scheduling logic lives in lib/visible-interval-scheduler.ts so
 * the contract is unit-testable without React/jsdom — this hook is
 * the React glue.
 *
 * `fn` may be async. We don't await it for scheduling — the timer
 * fires every `intervalMs` regardless of how long the previous call
 * took, matching plain setInterval semantics.
 */
export function useVisibleInterval(fn: () => void | Promise<void>, intervalMs: number) {
  // Stash the latest fn in a ref so the effect doesn't have to re-run
  // every render — consumers can pass an inline arrow function without
  // thrashing the scheduler.
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);

  useEffect(() => {
    const scheduler = createVisibleScheduler(() => { fnRef.current(); }, intervalMs);
    if (document.hidden) {
      // Hidden on mount — don't start the timer, don't even fire once.
    } else {
      scheduler.start();
    }

    const onVisibility = () => {
      if (document.hidden) scheduler.pause();
      else scheduler.resume();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      scheduler.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
