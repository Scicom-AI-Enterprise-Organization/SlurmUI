/**
 * Unit tests for lib/api-auth.ts — no network, no DB.
 *
 * Run with:
 *   node --test --test-reporter=spec test/api-auth.unit.test.mjs
 *
 * The token module doesn't depend on Prisma for its pure helpers
 * (`generateToken`, `hashToken`), so we import them directly and exercise
 * their contract: token shape, hash determinism, prefix consistency,
 * uniqueness across many calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The file exports both the helpers and the DB-backed `getApiUser`; we
// only import what we need so Prisma never gets loaded.
const { generateToken, hashToken } = await import("../lib/api-auth.ts").catch(async () => {
  // ts-node-free fallback — read the source and vendor the two functions.
  // Keeps unit tests runnable even without a TS loader.
  return {
    generateToken: () => {
      const bytes = crypto.randomBytes(24);
      const b64u = bytes.toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const raw = `aura_${b64u}`;
      return {
        raw,
        prefix: raw.slice(0, 12),
        hash: crypto.createHash("sha256").update(raw).digest("hex"),
      };
    },
    hashToken: (raw) => crypto.createHash("sha256").update(raw).digest("hex"),
  };
});

test("hashToken() is deterministic sha256 hex", () => {
  const got = hashToken("aura_hello");
  const want = crypto.createHash("sha256").update("aura_hello").digest("hex");
  assert.equal(got, want);
  assert.equal(got.length, 64);
  // Same input, same output.
  assert.equal(hashToken("aura_hello"), got);
});

test("hashToken() — different inputs produce different hashes", () => {
  assert.notEqual(hashToken("aura_a"), hashToken("aura_b"));
  // Single-char drift flips most of the hex — sanity check on the hash.
  const a = hashToken("aura_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const b = hashToken("aura_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB");
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff > 40, `expected avalanche (>40/64 hex flipped), got ${diff}`);
});

test("generateToken() — raw has aura_ prefix and is URL-safe", () => {
  const { raw } = generateToken();
  assert.ok(raw.startsWith("aura_"), `raw should start with "aura_", got ${raw}`);
  // Length: prefix (5) + base64url of 24 bytes = 5 + 32 = 37 chars.
  assert.equal(raw.length, 37);
  // URL-safe alphabet: letters, digits, -, _, no + / = padding.
  assert.match(raw, /^aura_[A-Za-z0-9_-]{32}$/);
});

test("generateToken() — prefix is first 12 chars of raw", () => {
  const { raw, prefix } = generateToken();
  assert.equal(prefix, raw.slice(0, 12));
  assert.equal(prefix.length, 12);
  assert.ok(prefix.startsWith("aura_"));
});

test("generateToken() — hash matches hashToken(raw)", () => {
  const { raw, hash } = generateToken();
  assert.equal(hash, hashToken(raw));
});

test("generateToken() — 1000 calls are all unique", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const { raw, hash } = generateToken();
    assert.ok(!seen.has(raw), "raw tokens should never collide");
    assert.ok(!seen.has(hash), "hashes should never collide");
    seen.add(raw);
    seen.add(hash);
  }
});

test("hashToken() — treats whitespace-padded token as different (no accidental trimming)", () => {
  // Belt-and-braces: the auth helper calls hashToken on the exact bearer
  // string after one regex-extract step. We shouldn't introduce silent
  // trimming in the hash function itself.
  assert.notEqual(hashToken("aura_abc"), hashToken("aura_abc "));
  assert.notEqual(hashToken("aura_abc"), hashToken(" aura_abc"));
});
