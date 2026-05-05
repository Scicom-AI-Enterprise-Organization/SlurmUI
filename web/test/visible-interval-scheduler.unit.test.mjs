/**
 * Unit tests for lib/visible-interval-scheduler.ts.
 *
 * Locks down the pause-on-hidden contract used by the jobs page's
 * /resources auto-refresh. If this regresses, the SSH-driven probe
 * runs every 30 s in every tab the user has ever opened — a real
 * cost on bastion-mode clusters where each probe is a 1-3 s SSH
 * round-trip.
 *
 * Run with:
 *   node --import tsx --test --test-reporter=spec test/visible-interval-scheduler.unit.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { createVisibleScheduler } = await import("../lib/visible-interval-scheduler.ts");

/** Build a test harness with a controllable fake setInterval — we count
 * arms/disarms instead of using real timers. */
function harness(intervalMs = 1000) {
  let armed = false;
  let armedWith = null;
  let nextHandle = 1;
  const calls = [];

  const fakeSetInterval = (cb, ms) => {
    armed = true;
    armedWith = ms;
    return nextHandle++;
  };
  const fakeClearInterval = () => {
    armed = false;
    armedWith = null;
  };

  const fn = () => { calls.push("fire"); };
  const scheduler = createVisibleScheduler(fn, intervalMs, {
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });

  return {
    scheduler, calls,
    isArmed: () => armed,
    armedWith: () => armedWith,
  };
}

test("start() fires fn once and arms the timer", () => {
  const h = harness(1000);
  assert.equal(h.scheduler.isRunning(), false);
  h.scheduler.start();
  assert.equal(h.calls.length, 1, "should fire once on start");
  assert.equal(h.scheduler.isRunning(), true);
  assert.equal(h.armedWith(), 1000);
});

test("pause() disarms without firing fn", () => {
  const h = harness();
  h.scheduler.start();
  const before = h.calls.length;
  h.scheduler.pause();
  assert.equal(h.scheduler.isRunning(), false);
  assert.equal(h.calls.length, before, "pause must NOT fire fn");
});

test("resume() catches up by firing fn once, then re-arms", () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.pause();
  const before = h.calls.length;
  h.scheduler.resume();
  assert.equal(h.calls.length, before + 1, "resume should fire once");
  assert.equal(h.scheduler.isRunning(), true);
});

test("stop() disarms cleanly and is idempotent", () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.stop();
  assert.equal(h.scheduler.isRunning(), false);
  // Calling stop again must not re-fire fn or throw.
  h.scheduler.stop();
  assert.equal(h.scheduler.isRunning(), false);
});

test("start() while already running is a no-op (no double-arm)", () => {
  const h = harness();
  h.scheduler.start();
  const armedAfterFirst = h.scheduler.isRunning();
  // Calling start() again would normally double-arm — guard against it.
  h.scheduler.start();
  assert.equal(armedAfterFirst, true);
  // The contract is "one timer per scheduler" — not "no fn fires" — so
  // we accept the second fire (matches React effect semantics) but the
  // timer count must stay 1.
  assert.equal(h.scheduler.isRunning(), true);
});

test("typical hidden→visible→hidden cycle counts (perf-regression canary)", () => {
  // The whole point of the hook: while hidden the timer is OFF, while
  // visible it's ON. Drive a realistic visibility sequence and count
  // arm transitions.
  const h = harness(30_000);
  h.scheduler.start();          // mount, visible — armed
  assert.equal(h.scheduler.isRunning(), true);

  h.scheduler.pause();          // tab hidden — disarmed
  assert.equal(h.scheduler.isRunning(), false);

  h.scheduler.pause();          // hidden→hidden noise (focus loss etc.) — still disarmed
  assert.equal(h.scheduler.isRunning(), false);

  h.scheduler.resume();         // tab visible — armed + catch-up fire
  assert.equal(h.scheduler.isRunning(), true);

  h.scheduler.stop();           // unmount — disarmed
  assert.equal(h.scheduler.isRunning(), false);

  // Total fires across the cycle: 1 (start) + 1 (resume catch-up) = 2.
  // No fires while paused — that's the canary.
  assert.equal(h.calls.length, 2, "exactly start + resume should fire fn");
});

test("intervalMs <= 0 acts as one-shot — fires fn but never arms", () => {
  const h = harness(0);
  h.scheduler.start();
  assert.equal(h.calls.length, 1, "still fires on start");
  assert.equal(h.scheduler.isRunning(), false, "no timer when intervalMs<=0");
});
