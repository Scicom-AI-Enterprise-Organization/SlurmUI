import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { runSacctmgrOnCluster, shellEscape, validName } from "@/lib/sacctmgr";

interface RouteParams { params: Promise<{ id: string; name: string; user: string }> }

async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session };
}

// DELETE /api/clusters/[id]/accounts/[name]/users/[user] — remove only the
// association of `user` within `account`. The Linux user and any other
// account associations are untouched.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, name, user } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  if (!validName(name)) return NextResponse.json({ error: "Invalid account name" }, { status: 400 });
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) {
    return NextResponse.json({ error: "Invalid unix username" }, { status: 400 });
  }

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `$S sacctmgr -i delete user where name=${shellEscape(user)} account=${shellEscape(name)} 2>&1`,
    );
    await logAudit({
      action: "account.user.remove",
      entity: "Cluster",
      entityId: id,
      metadata: { account: name, user, success: ok },
    });
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ deleted: user, output });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

// PATCH to modify an association's share, qos, partition, limits.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, name, user } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const body = (await req.json()) as {
    share?: string;
    defaultQos?: string;
    qos?: string;
  };

  const tokens: string[] = [];
  const push = (k: string, v?: string) => { if (v !== undefined) tokens.push(`${k}=${v === "" ? "-1" : shellEscape(v)}`); };
  push("Fairshare", body.share);
  push("DefaultQOS", body.defaultQos);
  push("QOS", body.qos);
  if (tokens.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `$S sacctmgr -i modify user where name=${shellEscape(user)} account=${shellEscape(name)} set ${tokens.join(" ")} 2>&1`,
    );
    await logAudit({
      action: "account.user.modify",
      entity: "Cluster",
      entityId: id,
      metadata: { account: name, user, fields: Object.keys(body), success: ok },
    });
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ updated: user, output });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
