import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string }> }

// GET — list python packages + venv location + available storage mounts
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  // packages may be legacy string[] — normalize to rich objects.
  const rawPackages = (config.python_packages as unknown[]) ?? [];
  const packages = rawPackages.map((p) =>
    typeof p === "string" ? { name: p } : (p as { name: string; indexUrl?: string; extraIndexUrl?: string })
  );
  const venvLocation = (config.python_venv_location as string) ?? "";
  const pythonVersion = (config.python_version as string) ?? "3.12";
  const installMode = ((config.python_install_mode as string) ?? "shared") as "shared" | "per-node";
  const localVenvPath = (config.python_local_venv_path as string) ?? "/opt/aura-venv";
  const storageMounts = (config.storage_mounts ?? []) as Array<{ id: string; mountPath: string; type: string }>;
  const dataNfsPath = (config.data_nfs_path as string) ?? "";

  // Most recent python_packages task so the UI can re-attach after refresh.
  const latestTask = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, type: "python_packages" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true },
  });

  return NextResponse.json({
    packages,
    venvLocation,
    pythonVersion,
    installMode,
    localVenvPath,
    storageMounts,
    dataNfsPath,
    latestTask,
  });
}

// PUT — save package list + venv location
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const rawPackages: Array<{ name: string; indexUrl?: string; extraIndexUrl?: string }> = body.packages ?? [];
  const venvLocation: string = body.venvLocation ?? "";
  const pythonVersion: string = (body.pythonVersion ?? "").trim() || "3.12";
  if (!/^3\.\d{1,2}(\.\d+)?$/.test(pythonVersion)) {
    return NextResponse.json({ error: "Invalid Python version (use e.g. 3.11, 3.12, 3.12.4)" }, { status: 400 });
  }
  const installMode: "shared" | "per-node" = body.installMode === "per-node" ? "per-node" : "shared";
  const localVenvPath: string = (body.localVenvPath ?? "/opt/aura-venv").trim() || "/opt/aura-venv";
  if (!/^\/[A-Za-z0-9_./-]+$/.test(localVenvPath)) {
    return NextResponse.json({ error: "Invalid local venv path" }, { status: 400 });
  }

  // Normalize: trim fields, drop empties.
  const packages = rawPackages
    .map((p) => ({
      name: (p.name ?? "").trim(),
      indexUrl: (p.indexUrl ?? "").trim() || undefined,
      extraIndexUrl: (p.extraIndexUrl ?? "").trim() || undefined,
    }))
    .filter((p) => p.name);

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  await prisma.cluster.update({
    where: { id },
    data: {
      config: {
        ...config,
        python_packages: packages,
        python_venv_location: venvLocation,
        python_version: pythonVersion,
        python_install_mode: installMode,
        python_local_venv_path: localVenvPath,
      } as any,
    },
  });

  return NextResponse.json({ packages, venvLocation, pythonVersion, installMode, localVenvPath });
}
