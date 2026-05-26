/**
 * Shared helpers for reading the `cluster.config.code_credentials.github`
 * blob. Lives in lib/ (not under app/api/) so other server-side modules
 * (the integrations page + submit-job) can import without tripping the
 * Next.js route-handler export validator, which only allows handler
 * functions (`GET`/`POST`/etc.) to be exported from `route.ts`.
 */

export interface GithubCred {
  id: string;
  name: string;
  username?: string;
  token: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Read the credentials array from a cluster's `config` JSONB. Falls
 * through to a single-element migration when an older deployment wrote
 * `code_credentials.github` as `{ username, token }` (one prior round
 * shipped that shape before we added multi-entry support).
 */
export function readGithubCredsList(config: unknown): GithubCred[] {
  if (!config || typeof config !== "object") return [];
  const cc = (config as Record<string, unknown>).code_credentials;
  if (!cc || typeof cc !== "object") return [];
  const gh = (cc as Record<string, unknown>).github;
  if (Array.isArray(gh)) {
    return gh.filter(
      (e): e is GithubCred =>
        !!e && typeof e === "object" &&
        typeof (e as GithubCred).id === "string" &&
        typeof (e as GithubCred).token === "string",
    );
  }
  if (gh && typeof gh === "object" && typeof (gh as { token?: unknown }).token === "string") {
    const legacy = gh as { username?: string; token: string; createdAt?: string };
    return [{
      id: "default",
      name: "default",
      username: legacy.username,
      token: legacy.token,
      createdAt: legacy.createdAt ?? new Date(0).toISOString(),
    }];
  }
  return [];
}
