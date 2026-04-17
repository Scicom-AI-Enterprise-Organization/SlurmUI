import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadConfig, saveConfig, GitSyncConfig } from "@/lib/git-sync";

const SECRET_MASK = "********";

// Strip embedded credentials from an https URL so https://user:pw@host/...
// doesn't flash back to the browser on reload. Keeps the URL usable; the
// server tacks credentials back on from httpsToken at push time.
function stripUrlCreds(url: string): string {
  if (!url.startsWith("http")) return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {}
  return url;
}

function maskSecrets(cfg: GitSyncConfig): GitSyncConfig {
  return {
    ...cfg,
    repoUrl: stripUrlCreds(cfg.repoUrl),
    deployKey: cfg.deployKey ? SECRET_MASK : "",
    httpsToken: cfg.httpsToken ? SECRET_MASK : "",
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = await loadConfig();
  return NextResponse.json(maskSecrets(cfg));
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const current = await loadConfig();
  const body = await req.json() as Partial<GitSyncConfig>;

  // If the client sends back the credential-stripped form of the saved URL,
  // keep the stored (possibly credential-bearing) URL. Only overwrite when
  // the user actually changes it.
  const incomingUrl = body.repoUrl ?? current.repoUrl;
  const keepExistingUrl = incomingUrl === stripUrlCreds(current.repoUrl);

  const next: GitSyncConfig = {
    ...current,
    ...body,
    repoUrl: keepExistingUrl ? current.repoUrl : incomingUrl,
    deployKey: body.deployKey === SECRET_MASK ? current.deployKey : (body.deployKey ?? current.deployKey),
    httpsToken: body.httpsToken === SECRET_MASK ? current.httpsToken : (body.httpsToken ?? current.httpsToken),
  };

  await saveConfig(next);
  return NextResponse.json(maskSecrets(next));
}
