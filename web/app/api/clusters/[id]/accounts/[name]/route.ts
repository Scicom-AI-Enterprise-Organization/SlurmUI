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

// PATCH /api/clusters/[id]/accounts/[name] — modify an account's fairshare,
// QoS, limits, parent.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, name } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  if (!validName(name)) return NextResponse.json({ error: "Invalid name" }, { status: 400 });

  const body = (await req.json()) as {
    parent?: string;
    share?: string;
    defaultQos?: string;
    qos?: string;
    grpTres?: string;
    maxJobs?: string;
    maxSubmit?: string;
  };

  const tokens: string[] = [];
  const push = (k: string, v?: string) => {
    if (v === undefined) return;
    tokens.push(`${k}=${v === "" ? "-1" : shellEscape(v)}`);
  };
  push("parent", body.parent);
  push("Fairshare", body.share);
  push("DefaultQOS", body.defaultQos);
  push("QOS", body.qos);
  push("GrpTRES", body.grpTres);
  push("MaxJobs", body.maxJobs);
  push("MaxSubmit", body.maxSubmit);
  if (tokens.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `$S sacctmgr -i modify account ${shellEscape(name)} set ${tokens.join(" ")} 2>&1`,
    );
    await logAudit({
      action: "account.modify",
      entity: "Cluster",
      entityId: id,
      metadata: { name, fields: Object.keys(body), success: ok },
    });
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ updated: name, output });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

// DELETE /api/clusters/[id]/accounts/[name]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, name } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  if (!validName(name)) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  if (name.toLowerCase() === "root") {
    return NextResponse.json({ error: "Cannot delete the built-in root account" }, { status: 400 });
  }

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `$S sacctmgr -i delete account where name=${shellEscape(name)} 2>&1`,
    );
    await logAudit({
      action: "account.delete",
      entity: "Cluster",
      entityId: id,
      metadata: { name, success: ok },
    });
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ deleted: name, output });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
