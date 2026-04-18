import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { runSacctmgrOnCluster, shellEscape, validName } from "@/lib/sacctmgr";

interface RouteParams { params: Promise<{ id: string; name: string }> }

async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session };
}

// POST /api/clusters/[id]/accounts/[name]/users — attach a user association to
// this account (creates a new row in `sacctmgr show associations`).
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, name } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  if (!validName(name)) return NextResponse.json({ error: "Invalid account name" }, { status: 400 });

  const body = (await req.json()) as {
    user?: string;
    share?: string;
    defaultQos?: string;
    qos?: string;
    partition?: string;
  };
  if (!body.user || !/^[a-z_][a-z0-9_-]*$/i.test(body.user)) {
    return NextResponse.json({ error: "Invalid unix username" }, { status: 400 });
  }

  const tokens: string[] = [`account=${shellEscape(name)}`];
  if (body.share) tokens.push(`Fairshare=${shellEscape(body.share)}`);
  if (body.defaultQos) tokens.push(`DefaultQOS=${shellEscape(body.defaultQos)}`);
  if (body.qos) tokens.push(`QOS=${shellEscape(body.qos)}`);
  if (body.partition) tokens.push(`partition=${shellEscape(body.partition)}`);

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `$S sacctmgr -i add user ${shellEscape(body.user)} ${tokens.join(" ")} 2>&1`,
    );
    await logAudit({
      action: "account.user.add",
      entity: "Cluster",
      entityId: id,
      metadata: { account: name, user: body.user, success: ok },
    });
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ created: body.user, output });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
