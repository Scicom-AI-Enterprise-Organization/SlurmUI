import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { runSacctmgrOnCluster, shellEscape, validName } from "@/lib/sacctmgr";

interface RouteParams { params: Promise<{ id: string }> }

interface AccountUser {
  user: string;
  partition: string;
  share: string;
  defaultQos: string;
  qos: string;
  maxJobs: string;
  maxSubmit: string;
  grpTres: string;
}

interface Account {
  name: string;
  parent: string;
  share: string;
  defaultQos: string;
  qos: string;
  maxJobs: string;
  maxSubmit: string;
  grpTres: string;
  users: AccountUser[];
}

async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session };
}

// GET /api/clusters/[id]/accounts — flatten `sacctmgr show associations` into
// a list of accounts (each with its direct user-rows) so the client can build
// the tree.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const format = "Cluster,ParentName,Account,User,Partition,Share,DefaultQOS,QOS,MaxJobs,MaxSubmit,GrpTRES";
  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `sacctmgr -P -n show associations format=${format} 2>&1`,
    );
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });

    const byName = new Map<string, Account>();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [, parent, accountName, user, partition, share, defaultQos, qos, maxJobs, maxSubmit, grpTres] =
        line.split("|");
      if (!accountName) continue;
      let acc = byName.get(accountName);
      if (!acc) {
        acc = {
          name: accountName,
          parent: parent ?? "",
          share: "",
          defaultQos: "",
          qos: "",
          maxJobs: "",
          maxSubmit: "",
          grpTres: "",
          users: [],
        };
        byName.set(accountName, acc);
      }
      if (!user) {
        // Account-level row
        acc.parent = parent ?? acc.parent;
        acc.share = share ?? acc.share;
        acc.defaultQos = defaultQos ?? acc.defaultQos;
        acc.qos = qos ?? acc.qos;
        acc.maxJobs = maxJobs ?? acc.maxJobs;
        acc.maxSubmit = maxSubmit ?? acc.maxSubmit;
        acc.grpTres = grpTres ?? acc.grpTres;
      } else {
        // Slurm emits one row per (user, account, partition[, QoS]) — the
        // same user under the same account with no partition set produces
        // repeat rows with identical display values. Collapse those here so
        // the UI doesn't show three identical `ariff_s` lines.
        const partKey = partition ?? "";
        if (acc.users.some((u) => u.user === user && u.partition === partKey)) continue;
        acc.users.push({
          user,
          partition: partKey,
          share: share ?? "",
          defaultQos: defaultQos ?? "",
          qos: qos ?? "",
          maxJobs: maxJobs ?? "",
          maxSubmit: maxSubmit ?? "",
          grpTres: grpTres ?? "",
        });
      }
    }

    return NextResponse.json({ accounts: [...byName.values()] });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

// POST /api/clusters/[id]/accounts — create an account.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const body = (await req.json()) as {
    name?: string;
    parent?: string;
    share?: string;
    defaultQos?: string;
    qos?: string;
    grpTres?: string;
    maxJobs?: string;
    maxSubmit?: string;
    description?: string;
    organization?: string;
  };

  if (!body.name || !validName(body.name)) {
    return NextResponse.json({ error: "Invalid account name" }, { status: 400 });
  }

  const tokens: string[] = [];
  if (body.parent) tokens.push(`parent=${shellEscape(body.parent)}`);
  if (body.description) tokens.push(`Description=${shellEscape(body.description)}`);
  if (body.organization) tokens.push(`Organization=${shellEscape(body.organization)}`);
  if (body.share) tokens.push(`Fairshare=${shellEscape(body.share)}`);
  if (body.defaultQos) tokens.push(`DefaultQOS=${shellEscape(body.defaultQos)}`);
  if (body.qos) tokens.push(`QOS=${shellEscape(body.qos)}`);
  if (body.grpTres) tokens.push(`GrpTRES=${shellEscape(body.grpTres)}`);
  if (body.maxJobs) tokens.push(`MaxJobs=${shellEscape(body.maxJobs)}`);
  if (body.maxSubmit) tokens.push(`MaxSubmit=${shellEscape(body.maxSubmit)}`);

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `$S sacctmgr -i add account ${shellEscape(body.name)} ${tokens.join(" ")} 2>&1`,
    );
    await logAudit({
      action: "account.create",
      entity: "Cluster",
      entityId: id,
      metadata: { name: body.name, parent: body.parent, success: ok },
    });
    if (!ok) return NextResponse.json({ error: output || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ created: body.name, output });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
