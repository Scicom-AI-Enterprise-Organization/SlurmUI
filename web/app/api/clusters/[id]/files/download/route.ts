import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

interface Root { id: string; base: string }

function resolveRoots(config: Record<string, unknown>, username: string): Root[] {
  const roots: Root[] = [];
  const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "/aura-usrdata";
  roots.push({ id: "home", base: `${dataNfsPath}/${username}` });
  const mounts = (config.storage_mounts as Array<{ id: string; mountPath: string }> | undefined) ?? [];
  for (const m of mounts) roots.push({ id: m.id, base: m.mountPath });
  return roots;
}

function safeJoin(base: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const parts = rel.split("/").filter(Boolean);
  for (const p of parts) if (p === "..") return null;
  return parts.length === 0 ? base : `${base.replace(/\/+$/, "")}/${parts.join("/")}`;
}

// GET /api/clusters/[id]/files/download?path=...&root=<rootId>
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
    return NextResponse.json({ error: "No provisioned user on this cluster." }, { status: 403 });
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
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  const root = roots.find((r) => r.id === rootId) ?? roots[0];
  const abs = safeJoin(root.base, path);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  // SSH mode: stream file base64-encoded through the SSH pipe.
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    const marker = `__DL_${Date.now()}__`;
    // Cap at 50 MB so the bastion pipe isn't abused; larger files need a
    // different transport.
    const script = `#!/bin/bash
set +e
echo "${marker}_START"
if [ ! -f ${JSON.stringify(abs)} ]; then
  echo "__NOT_FILE__"
elif [ $(stat -c %s ${JSON.stringify(abs)}) -gt 52428800 ]; then
  echo "__TOO_LARGE__"
else
  base64 -w 0 ${JSON.stringify(abs)}
fi
echo ""
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

    if (body.includes("__NOT_FILE__")) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    if (body.includes("__TOO_LARGE__")) {
      return NextResponse.json({ error: "File exceeds 50 MB download limit" }, { status: 413 });
    }

    const b64 = body.replace(/\s+/g, "");
    const bytes = Buffer.from(b64, "base64");
    const name = abs.split("/").pop() || "file";
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": String(bytes.length),
      },
    });
  }

  // NATS mode: unchanged.
  const nfsHome = root.base;
  const result = await sendCommandAndWait(id, {
    request_id: crypto.randomUUID(),
    type: "read_file",
    payload: { path, nfs_home: nfsHome },
  }, 30_000) as any;

  if (result?.type === "error") {
    return NextResponse.json({ error: result.payload?.error ?? "Failed to read file" }, { status: 500 });
  }

  const bytes = Buffer.from(result.content, "base64");
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${result.name}"`,
      "Content-Length": String(bytes.length),
    },
  });
}
