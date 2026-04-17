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

// POST — create/update shared venv at the selected storage path and pip install
// the tracked package list. All work runs on the controller; workers pick up
// the venv through the shared mount.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = cluster.config as Record<string, unknown>;
  const rawPackages = (config.python_packages as unknown[]) ?? [];
  const packages = rawPackages.map((p) =>
    typeof p === "string" ? { name: p } : (p as { name: string; indexUrl?: string; extraIndexUrl?: string })
  );
  const venvLocation = (config.python_venv_location as string) ?? "";
  const pythonVersion = (config.python_version as string) ?? "3.12";
  const installMode = ((config.python_install_mode as string) ?? "shared") as "shared" | "per-node";
  const localVenvPath = (config.python_local_venv_path as string) ?? "/opt/aura-venv";
  if (installMode === "shared" && !venvLocation) {
    return NextResponse.json({ error: "Select a storage location first" }, { status: 400 });
  }
  if (packages.length === 0) {
    return NextResponse.json({ error: "No packages configured" }, { status: 400 });
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

  const isShared = installMode === "shared";
  const venvPath = isShared
    ? `${venvLocation.replace(/\/+$/, "")}/aura-venv`
    : localVenvPath.replace(/\/+$/, "");
  const urlValid = (s?: string) => !!s && /^https?:\/\//.test(s);

  // Group packages by (indexUrl, extraIndexUrl) so each distinct index only
  // triggers one pip call. PyTorch on cu128 then installs together in one pass.
  const groups = new Map<string, { indexUrl?: string; extraIndexUrl?: string; names: string[] }>();
  for (const p of packages) {
    const iu = urlValid(p.indexUrl) ? p.indexUrl : undefined;
    const eu = urlValid(p.extraIndexUrl) ? p.extraIndexUrl : undefined;
    const key = `${iu ?? ""}|${eu ?? ""}`;
    if (!groups.has(key)) groups.set(key, { indexUrl: iu, extraIndexUrl: eu, names: [] });
    groups.get(key)!.names.push(p.name);
  }

  const installSteps = Array.from(groups.values()).map((g) => {
    const flags: string[] = [];
    if (g.indexUrl) flags.push(`--index-url ${JSON.stringify(g.indexUrl)}`);
    if (g.extraIndexUrl) flags.push(`--extra-index-url ${JSON.stringify(g.extraIndexUrl)}`);
    const pkgList = g.names.map((n) => JSON.stringify(n)).join(" ");
    const desc = g.indexUrl ? ` (index: ${g.indexUrl})` : "";
    return `
echo "[aura] Installing ${g.names.length} package(s)${desc}..."
"$UV" pip install --python "${venvPath}/bin/python" ${flags.join(" ")} ${pkgList} 2>&1 | tail -40 || true`;
  }).join("\n");

  // uv binary location depends on mode:
  //   - shared:   <venvLocation>/uv-bin/ on shared storage, reused across nodes
  //   - per-node: sibling of the venv (NOT inside), so rm -rf'ing the venv
  //               during version changes doesn't also nuke uv.
  const uvBinDir = isShared
    ? `${venvLocation.replace(/\/+$/, "")}/uv-bin`
    : `${venvPath}-uv-bin`;

  // Inner "install into this venv" snippet, reusable for both modes.
  const installBlock = `
S=""; [ "$(id -u)" != "0" ] && S="sudo"
ME=$(id -un)
MYGID=$(id -gn)

# Create parent + uv-bin dirs (with sudo if needed). Do NOT pre-create venvPath
# itself — uv venv refuses to populate an existing directory without --clear.
$S mkdir -p "$(dirname "${venvPath}")" "${uvBinDir}"
$S chown -R "$ME:$MYGID" "$(dirname "${venvPath}")" 2>/dev/null || true

UV="${uvBinDir}/uv"

if [ ! -x "$UV" ]; then
  echo "[aura] Installing uv into ${uvBinDir}..."
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${uvBinDir}" UV_UNMANAGED_INSTALL=1 INSTALLER_NO_MODIFY_PATH=1 sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${uvBinDir}" UV_UNMANAGED_INSTALL=1 INSTALLER_NO_MODIFY_PATH=1 sh
  else
    echo "[error] Neither curl nor wget is available to fetch uv"
    exit 1
  fi
  [ ! -x "$UV" ] && [ -x "${uvBinDir}/bin/uv" ] && UV="${uvBinDir}/bin/uv"
fi

echo "[aura] uv version: $("$UV" --version 2>&1)"

if [ ! -f "${venvPath}/bin/python" ]; then
  # If the directory exists (leftover from a failed run) but has no python,
  # clear it so uv venv can populate it.
  [ -d "${venvPath}" ] && rm -rf "${venvPath}"
  echo "[aura] Creating venv at ${venvPath} (Python ${pythonVersion})..."
  "$UV" venv "${venvPath}" --python "${pythonVersion}" 2>&1 | tail -20
else
  EXISTING_VER=$("${venvPath}/bin/python" -c 'import sys; print(".".join(str(x) for x in sys.version_info[:2]))' 2>/dev/null || echo "?")
  WANT_MAJ_MIN=$(echo "${pythonVersion}" | cut -d. -f1,2)
  if [ "$EXISTING_VER" != "$WANT_MAJ_MIN" ]; then
    echo "[aura] Recreating venv — requested Python ${pythonVersion}, found $EXISTING_VER"
    rm -rf "${venvPath}"
    "$UV" venv "${venvPath}" --python "${pythonVersion}" 2>&1 | tail -20
  else
    echo "[aura] Reusing existing venv (Python $EXISTING_VER) at ${venvPath}"
  fi
fi

${installSteps}

echo "[aura] Installed package summary:"
"$UV" pip list --python "${venvPath}/bin/python" 2>&1 | tail -20
`;

  let script: string;
  if (isShared) {
    script = `#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  Mode: shared"
echo "  Venv: ${venvPath}"
echo "  Python: ${pythonVersion}"
echo "  Packages: ${packages.length}"
echo "============================================"
echo ""
${installBlock}
echo ""
echo "[aura] Done. Activate with: source ${venvPath}/bin/activate"
`;
  } else {
    // Per-node: loop over hosts_entries, SSH from controller to each, run install
    // inline via heredoc. Runs sequentially so we get clean per-node log sections.
    interface HostEntry { hostname: string; ip: string; user?: string; port?: number }
    const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
    const targets = hostsEntries.length > 0 ? hostsEntries : [{ hostname: cluster.controllerHost, ip: cluster.controllerHost }];

    const workerBlock = targets.map((h) => {
      const u = h.user || "root";
      const p = h.port || 22;
      return `
echo "============================================"
echo "  [${h.hostname}] Installing..."
echo "============================================"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${u}@${h.ip} bash -s <<'NODE_EOF'
set +e
${installBlock}
NODE_EOF
echo ""`;
    }).join("\n");

    script = `#!/bin/bash
set +e

echo "============================================"
echo "  Mode: per-node"
echo "  Venv (each node): ${venvPath}"
echo "  Python: ${pythonVersion}"
echo "  Packages: ${packages.length}"
echo "  Targets: ${targets.length}"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "[aura] Done. Activate in jobs with: source ${venvPath}/bin/activate"
`;
  }

  (async () => {
    await appendLog(task.id, `[aura] Applying ${packages.length} python package(s) to ${venvPath}`);
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, "\n[aura] Python packages applied successfully.");
          await logAudit({ action: "python_packages.apply", entity: "Cluster", entityId: id, metadata: { packages, venvPath } });
        } else {
          await appendLog(task.id, "\n[aura] Python package installation failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id, venvPath });
}
