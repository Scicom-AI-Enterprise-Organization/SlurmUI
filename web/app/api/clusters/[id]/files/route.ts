import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

interface Root { id: string; label: string; base: string; type: string }

function resolveRoots(config: Record<string, unknown>, username: string): Root[] {
  const roots: Root[] = [];
  const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "/aura-usrdata";
  const homeBase = `${dataNfsPath}/${username}`;
  roots.push({
    id: "home",
    label: `Home (${homeBase})`,
    base: homeBase,
    type: "home",
  });
  const mounts = (config.storage_mounts as Array<{ id: string; mountPath: string; type: string }> | undefined) ?? [];
  for (const m of mounts) {
    roots.push({ id: m.id, label: `${m.mountPath} (${m.type})`, base: m.mountPath, type: m.type });
  }
  return roots;
}

// Reject paths that try to escape the root with .. components or absolute paths.
function safeJoin(base: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const parts = rel.split("/").filter(Boolean);
  for (const p of parts) if (p === "..") return null;
  return parts.length === 0 ? base : `${base.replace(/\/+$/, "")}/${parts.join("/")}`;
}

// GET /api/clusters/[id]/files?path=...&root=<rootId>
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const clusterUser = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId: session.user.id, clusterId: id } },
  });
  if (!clusterUser || clusterUser.status !== "ACTIVE") {
    return NextResponse.json(
      { error: "No provisioned user on this cluster. Contact your admin." },
      { status: 403 }
    );
  }

  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!dbUser?.unixUsername) {
    return NextResponse.json({ error: "No Linux account provisioned" }, { status: 403 });
  }

  const config = cluster.config as Record<string, unknown>;
  const roots = resolveRoots(config, dbUser.unixUsername);
  const url = new URL(req.url);
  const rootId = url.searchParams.get("root") ?? "home";
  const path = url.searchParams.get("path") ?? "";
  const root = roots.find((r) => r.id === rootId) ?? roots[0];
  const abs = safeJoin(root.base, path);
  if (!abs) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // SSH mode — run find on the controller.
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) {
      return NextResponse.json({ error: "No SSH key" }, { status: 412 });
    }

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    const marker = `__FILES_${Date.now()}__`;
    // %P=rel name, %y=d|f|l|…, %s=size, %TY-... =modified, %M=mode
    const script = `#!/bin/bash
set +e
echo "${marker}_START"
if [ ! -d ${JSON.stringify(abs)} ]; then
  echo "__NOT_DIR__"
else
  find ${JSON.stringify(abs)} -maxdepth 1 -mindepth 1 -printf '%P|%y|%s|%TY-%Tm-%TdT%TH:%TM:%TS|%M\\n' 2>/dev/null | head -5000
fi
echo "${marker}_END"
`;
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      sshExecScript(target, script, {
        onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
        onComplete: () => resolve(),
      });
    });
    const full = chunks.join("\n");
    const startIdx = full.indexOf(`${marker}_START`);
    const endIdx = full.indexOf(`${marker}_END`);
    const body = startIdx !== -1 && endIdx !== -1
      ? full.slice(startIdx + `${marker}_START`.length, endIdx).trim()
      : full.trim();

    if (body.includes("__NOT_DIR__")) {
      return NextResponse.json({ error: `Path not found: ${abs}`, roots, path, rootId: root.id }, { status: 404 });
    }

    const entries = body.split("\n").filter(Boolean).map((line) => {
      const [name, type, size, modified, mode] = line.split("|");
      return {
        name: name ?? "",
        is_dir: type === "d",
        size: parseInt(size || "0", 10) || 0,
        modified: modified ?? "",
        mode: mode ?? "",
      };
    }).filter((e) => e.name);

    return NextResponse.json({ entries, roots, path, rootId: root.id });
  }

  // NATS mode — unchanged.
  const nfsHome = root.base;
  const result = await sendCommandAndWait(id, {
    request_id: crypto.randomUUID(),
    type: "list_files",
    payload: { path, nfs_home: nfsHome },
  }, 15_000) as any;

  if (result?.type === "error") {
    return NextResponse.json(
      { error: result.payload?.error ?? "Failed to list files" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ...result, roots, path, rootId: root.id });
}
