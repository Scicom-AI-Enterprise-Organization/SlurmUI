import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

interface Root { id: string; base: string }

function resolveRoots(config: Record<string, unknown>, username: string): Root[] {
  const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "/aura-usrdata";
  const roots: Root[] = [{ id: "home", base: `${dataNfsPath}/${username}` }];
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

// POST /api/clusters/[id]/files/write
// body: { path, root, content }  — content is the raw text to write
// body: { path, root, base64 }   — or base64-encoded bytes for binary uploads
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

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

  const body = await req.json();
  const rootId = (body.root as string) ?? "home";
  const path = (body.path as string) ?? "";
  const content = typeof body.content === "string" ? body.content : null;
  const base64 = typeof body.base64 === "string" ? body.base64 : null;
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  if (content === null && base64 === null) {
    return NextResponse.json({ error: "content or base64 is required" }, { status: 400 });
  }

  const config = cluster.config as Record<string, unknown>;
  const roots = resolveRoots(config, dbUser.unixUsername);
  const root = roots.find((r) => r.id === rootId) ?? roots[0];
  const abs = safeJoin(root.base, path);
  if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  const payload = base64 ?? Buffer.from(content ?? "", "utf8").toString("base64");
  // Cap 10 MB per write to keep the bastion pipe snappy.
  const bytesLen = Math.floor(payload.length * 3 / 4);
  if (bytesLen > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File exceeds 10 MB write limit" }, { status: 413 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__WRITE_${Date.now()}__`;
  const b64Lines = payload.match(/.{1,76}/g) ?? [payload];
  const catBlock = b64Lines.map((l: string) => `echo "${l}"`).join("\n");
  const script = `#!/bin/bash
set +e
echo "${marker}_START"
mkdir -p "$(dirname ${JSON.stringify(abs)})" 2>/dev/null
(
${catBlock}
) | base64 -d > ${JSON.stringify(abs)} && echo "OK" || echo "FAIL"
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
  const out = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + `${marker}_START`.length, endIdx).trim()
    : full.trim();

  if (!out.includes("OK")) {
    return NextResponse.json({ error: "Write failed", detail: out }, { status: 500 });
  }
  return NextResponse.json({ ok: true, path: abs, bytes: bytesLen });
}
