/**
 * Unit tests for lib/role-cache.ts.
 *
 * Locks down the perf contract used by NextAuth's jwt callback: a
 * per-process TTL cache that collapses N parallel User.findUnique
 * calls into 1 + (N-1)*hit. If this regresses, every authenticated
 * page load goes back to N round-trips against Postgres for the role
 * column on every parallel API call.
 *
 * Run with:
 *   node --import tsx --test --test-reporter=spec test/role-cache.unit.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { createRoleCache } = await import("../lib/role-cache.ts");

// Build a cache wired to a manual clock so we don't sleep in tests.
function freshClockedCache(ttlMs = 1000) {
  const state = { now: 1_000_000 };
  const cache = createRoleCache({ ttlMs, now: () => state.now });
  return { cache, advance: (ms) => { state.now += ms; } };
}

test("get() returns null on miss", () => {
  const { cache } = freshClockedCache();
  assert.equal(cache.get("u1"), null);
  assert.equal(cache.size(), 0);
});

test("set() then get() returns the stored role within TTL", () => {
  const { cache } = freshClockedCache(1000);
  cache.set("u1", "ADMIN");
  assert.equal(cache.get("u1"), "ADMIN");
  // Still within TTL — repeated reads are all hits.
  assert.equal(cache.get("u1"), "ADMIN");
  assert.equal(cache.size(), 1);
});

test("get() returns null after TTL expiry", () => {
  const { cache, advance } = freshClockedCache(1000);
  cache.set("u1", "ADMIN");
  advance(999);
  assert.equal(cache.get("u1"), "ADMIN", "still warm at ttl-1");
  advance(1);
  assert.equal(cache.get("u1"), null, "miss exactly at ttl");
});

test("expired entries are evicted on read (no unbounded growth)", () => {
  const { cache, advance } = freshClockedCache(1000);
  cache.set("u1", "ADMIN");
  cache.set("u2", "VIEWER");
  assert.equal(cache.size(), 2);
  advance(2000);
  // Reading a now-expired key drops it.
  cache.get("u1");
  assert.equal(cache.size(), 1, "stale entry should be evicted on miss");
});

test("set() refreshes the timestamp (sliding write, not sliding read)", () => {
  const { cache, advance } = freshClockedCache(1000);
  cache.set("u1", "ADMIN");
  advance(800);
  // A read shouldn't extend the TTL — only set() does.
  cache.get("u1");
  advance(300);
  assert.equal(cache.get("u1"), null, "read must not extend TTL");

  cache.set("u1", "ADMIN");
  advance(500);
  assert.equal(cache.get("u1"), "ADMIN", "fresh set restarts the window");
});

test("invalidate() drops a single entry without touching others", () => {
  const { cache } = freshClockedCache();
  cache.set("u1", "ADMIN");
  cache.set("u2", "VIEWER");
  cache.invalidate("u1");
  assert.equal(cache.get("u1"), null);
  assert.equal(cache.get("u2"), "VIEWER");
});

test("clear() drops everything", () => {
  const { cache } = freshClockedCache();
  cache.set("u1", "ADMIN");
  cache.set("u2", "VIEWER");
  cache.clear();
  assert.equal(cache.size(), 0);
});

test("dedupes N parallel hits against one DB lookup", () => {
  // Simulates the jwt-callback workload: a page fires 5 API calls in
  // parallel, each tries to read role. With the cache, the first
  // miss-then-set covers the rest.
  const { cache } = freshClockedCache(30_000);
  let dbHits = 0;
  const lookup = (userId) => {
    let role = cache.get(userId);
    if (role === null) {
      dbHits += 1;
      role = "ADMIN";
      cache.set(userId, role);
    }
    return role;
  };
  for (let i = 0; i < 5; i++) lookup("u1");
  assert.equal(dbHits, 1, "five parallel reads should pay for one DB round-trip");
});
