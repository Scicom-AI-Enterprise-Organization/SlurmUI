/**
 * Test a GitHub token against the GitHub REST API.
 *
 * POST /api/clusters/[id]/code-credentials/github/test
 *   body: { token: string }
 *
 * Hits `GET https://api.github.com/user` with the supplied token — the
 * single cheapest authenticated endpoint that verifies (a) the token is
 * valid and (b) the API can be reached from Aura's egress path. Returns
 * the authenticated login on success so the user gets confirmation that
 * they pasted the right token (not a stale one from another account).
 *
 * The test endpoint does NOT persist anything — the form takes the
 * result and decides whether to allow the actual PUT.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, _ctx: RouteParams) {
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length < 8) {
    return NextResponse.json({
      success: false,
      error: "GitHub token is required.",
    });
  }

  // 10s timeout — same default as the mlflow/wandb probes. GitHub's
  // /user endpoint is fast (< 200 ms p95) so a quiet 10s gives plenty
  // of head-room for transient slow paths without keeping the UI
  // spinner up for ages on a misconfigured network.
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub requires a User-Agent on every request. Without it the
        // API returns 403 with "Request forbidden by administrative rules."
        "User-Agent": "aura-slurmui",
      },
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      return NextResponse.json({
        success: false,
        error: "Token rejected by GitHub (401). Check the value at https://github.com/settings/tokens.",
      });
    }
    if (res.status === 403) {
      // Either rate-limited or the token's scopes are insufficient. We
      // can't tell from here without burning a second call, so surface
      // both possibilities and let the user investigate.
      return NextResponse.json({
        success: false,
        error: "GitHub returned 403. Token may be valid but lacks required scopes, or you've hit a rate limit.",
      });
    }
    if (!res.ok) {
      return NextResponse.json({
        success: false,
        error: `HTTP ${res.status} from api.github.com/user`,
      });
    }
    const data = (await res.json()) as { login?: string; name?: string };
    return NextResponse.json({
      success: true,
      message: `Authenticated as ${data.login ?? "(unknown)"}${data.name ? ` (${data.name})` : ""}`,
      login: data.login,
    });
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: e instanceof Error ? e.message : "Network error reaching api.github.com",
    });
  } finally {
    clearTimeout(timeout);
  }
}
