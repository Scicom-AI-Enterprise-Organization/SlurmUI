import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }

async function appendLog(taskId: string, line: string) {
  try {
    await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${taskId}`;
  } catch {}
}

async function finishTask(taskId: string, success: boolean) {
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: success ? "success" : "failed", completedAt: new Date() },
  });
}

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

// DELETE — uninstall one or more python packages from the managed venv and
// drop them from the stored config only AFTER `pip uninstall` actually
// succeeds. Body: { packages: string[] } (just the names; no index/url).
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const targetNames: string[] = (body.packages ?? []).map((n: unknown) => String(n).trim()).filter(Boolean);
  if (targetNames.length === 0) {
    return NextResponse.json({ error: "No packages specified" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = cluster.config as Record<string, unknown>;
  const venvLocation = (config.python_venv_location as string) ?? "";
  const installMode = ((config.python_install_mode as string) ?? "shared") as "shared" | "per-node";
  const localVenvPath = (config.python_local_venv_path as string) ?? "/opt/aura-venv";
  const venvPath = installMode === "shared"
    ? `${venvLocation.replace(/\/+$/, "")}/aura-venv`
    : localVenvPath.replace(/\/+$/, "");
  if (installMode === "shared" && !venvLocation) {
    return NextResponse.json({ error: "No venv location configured" }, { status: 400 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "python_packages" },
  });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  // Strip any version specifier for uninstall — `uv pip uninstall numpy==1.26.4`
  // is invalid; uv/pip only accept bare names. We also drop the same names
  // from config at the end (by original string match), so the version spec
  // survives there.
  const bareNames = targetNames.map((n) => n.split(/[=<>!~ \t]/)[0]).filter(Boolean);
  const pkgArgs = bareNames.map((n) => JSON.stringify(n)).join(" ");

  // uv lives alongside the venv — same layout the apply route uses.
  const uvBinDir = installMode === "shared"
    ? `${venvLocation.replace(/\/+$/, "")}/uv-bin`
    : `${venvPath}-uv-bin`;

  // The venv was created by uv (no bundled pip module), so we must go
  // through `uv pip uninstall` rather than `python -m pip uninstall`.
  // Exit nonzero on actual uninstall failure so the BackgroundTask flips
  // to "failed" and the UI doesn't strip the chip from the table.
  const uninstallBlock = `
if [ ! -x "${venvPath}/bin/python" ]; then
  echo "[aura] No venv at ${venvPath} — nothing to uninstall."
  exit 0
fi

UV="${uvBinDir}/uv"
if [ ! -x "$UV" ] && [ -x "${uvBinDir}/bin/uv" ]; then UV="${uvBinDir}/bin/uv"; fi
if [ ! -x "$UV" ]; then
  echo "[error] uv binary not found at ${uvBinDir} — cannot uninstall. Re-apply first to provision uv."
  exit 1
fi
echo "[aura] uv version: $("$UV" --version 2>&1)"

echo "[aura] uv pip uninstall ${bareNames.join(" ")}"
"$UV" pip uninstall --python "${venvPath}/bin/python" ${pkgArgs} 2>&1 | tail -40
RC=\${PIPESTATUS[0]}

echo "[aura] Post-uninstall package summary:"
"$UV" pip list --python "${venvPath}/bin/python" 2>&1 | tail -20

exit $RC
`;

  let script: string;
  if (installMode === "shared") {
    script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Uninstalling from shared venv: ${venvPath}"
echo "  Packages: ${targetNames.join(", ")}"
echo "============================================"
echo ""
${uninstallBlock}
`;
  } else {
    interface HostEntry { hostname: string; ip: string; user?: string; port?: number }
    const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
    const targets = hostsEntries.length > 0 ? hostsEntries : [{ hostname: cluster.controllerHost, ip: cluster.controllerHost }];

    const workerBlock = targets.map((h) => {
      const u = h.user || "root";
      const p = h.port || 22;
      return `
echo "============================================"
echo "  [${h.hostname}] Uninstalling..."
echo "============================================"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${u}@${h.ip} bash -s <<'NODE_EOF'
set +e
${uninstallBlock}
NODE_EOF
RC=$?
if [ $RC -ne 0 ]; then
  echo "[aura] [${h.hostname}] uninstall failed (rc=$RC)"
  FAILED=$((FAILED+1))
fi
echo ""`;
    }).join("\n");

    script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Mode: per-node"
echo "  Venv (each node): ${venvPath}"
echo "  Packages: ${targetNames.join(", ")}"
echo "  Targets: ${targets.length}"
echo "============================================"
echo ""
FAILED=0
${workerBlock}

if [ "$FAILED" -ne 0 ]; then
  echo "[aura] $FAILED of ${targets.length} node(s) failed"
  exit 1
fi
`;
  }

  (async () => {
    await appendLog(task.id, `[aura] Uninstalling ${targetNames.length} python package(s): ${targetNames.join(", ")}`);
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          try {
            const fresh = await prisma.cluster.findUnique({ where: { id } });
            if (fresh) {
              const cfg = (fresh.config ?? {}) as Record<string, unknown>;
              const rawPackages = (cfg.python_packages as unknown[]) ?? [];
              const remaining = rawPackages
                .map((p) => (typeof p === "string" ? { name: p } : (p as { name: string })))
                .filter((p) => !targetNames.includes(p.name));
              await prisma.cluster.update({
                where: { id },
                data: { config: { ...cfg, python_packages: remaining } as any },
              });
            }
          } catch {}
          await appendLog(task.id, "\n[aura] Python packages uninstalled successfully.");
          await logAudit({ action: "python_packages.uninstall", entity: "Cluster", entityId: id, metadata: { packages: targetNames, venvPath } });
        } else {
          await appendLog(task.id, "\n[aura] Python package uninstall failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
