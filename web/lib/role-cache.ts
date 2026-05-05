/**
 * Tiny TTL cache used by the NextAuth jwt callback to deduplicate
 * `User.findUnique({ select: { role } })` lookups across parallel
 * requests on the same user.
 *
 * Why a separate module: extracting the cache makes the perf contract
 * testable without spinning up Prisma or NextAuth. The auth callback
 * imports `getRole` / `setRole` and the unit tests drive them with an
 * injectable clock.
 *
 * Process-local. Safe across multi-replica deploys because each replica
 * caches independently — staleness is bounded at TTL × N.
 */

export interface RoleEntry<R = string> {
  role: R;
  /** ms-since-epoch the value was written. Used by the TTL check. */
  at: number;
}

/**
 * Build a cache instance. The default TTL is 30 s — long enough to
 * collapse a typical page load (which fires N parallel API calls in
 * <1 s) into a single DB lookup, short enough that an admin demoting a
 * user sees the change well within an HTTP keep-alive window.
 *
 * `now` is injectable so tests can advance time without `setTimeout`.
 */
export function createRoleCache<R = string>(opts?: { ttlMs?: number; now?: () => number }) {
  const ttlMs = opts?.ttlMs ?? 30_000;
  const now = opts?.now ?? (() => Date.now());
  const map = new Map<string, RoleEntry<R>>();

  return {
    /** Read a cached role. Returns null on miss OR if the entry is past TTL. */
    get(userId: string): R | null {
      const entry = map.get(userId);
      if (!entry) return null;
      if (now() - entry.at >= ttlMs) {
        map.delete(userId); // proactive cleanup so the map doesn't grow unbounded
        return null;
      }
      return entry.role;
    },
    /** Write a role into the cache. The timestamp is taken from the injected clock. */
    set(userId: string, role: R): void {
      map.set(userId, { role, at: now() });
    },
    /** Drop a single entry. Call when an admin promotes/demotes via Aura UI. */
    invalidate(userId: string): void {
      map.delete(userId);
    },
    /** Drop the entire cache. Mostly for tests. */
    clear(): void {
      map.clear();
    },
    /** Current entry count. For introspection / tests. */
    size(): number {
      return map.size;
    },
  };
}
