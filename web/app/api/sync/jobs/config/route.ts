import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  loadGitOpsJobsConfig,
  saveGitOpsJobsConfig,
  type GitOpsJobsConfig,
} from "@/lib/gitops-jobs";

// Admin-only. Shape + masking convention mirrors /api/settings/git-sync so
// the UI component is symmetrical. Secrets are sent back as a sentinel mask;
// the client round-trips the mask unchanged to preserve the stored value.

const SECRET_MASK = "********";

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

function maskSecrets(cfg: GitOpsJobsConfig): GitOpsJobsConfig {
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
  return NextResponse.json(maskSecrets(await loadGitOpsJobsConfig()));
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const current = await loadGitOpsJobsConfig();
  const body = await req.json() as Partial<GitOpsJobsConfig>;

  const incomingUrl = body.repoUrl ?? current.repoUrl;
  const keepExistingUrl = incomingUrl === stripUrlCreds(current.repoUrl);

  const next: GitOpsJobsConfig = {
    ...current,
    ...body,
    repoUrl: keepExistingUrl ? current.repoUrl : incomingUrl,
    deployKey: body.deployKey === SECRET_MASK ? current.deployKey : (body.deployKey ?? current.deployKey),
    httpsToken: body.httpsToken === SECRET_MASK ? current.httpsToken : (body.httpsToken ?? current.httpsToken),
  };

  await saveGitOpsJobsConfig(next);
  return NextResponse.json(maskSecrets(await loadGitOpsJobsConfig()));
}
