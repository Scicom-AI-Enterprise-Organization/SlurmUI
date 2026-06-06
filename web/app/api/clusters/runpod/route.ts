import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { createRunPodPod, DEFAULT_RUNPOD_IMAGE, DEFAULT_SLURM_NODE_IMAGE, SLURM_NODE_CUDA_VERSIONS } from "@/lib/gpu-provider";
import { runRunpodProvision } from "@/lib/runpod-provision";

// POST /api/clusters/runpod — create a single-node cluster backed by a
// freshly-rented RunPod pod. The pod is created first (nothing is persisted
// if RunPod refuses), then the cluster row + a "runpod_provision" background
// task that polls until the pod's SSH endpoint is live. Returns
// { id, taskId } — the UI follows the task logs and lands on the cluster's
// Configuration tab for the usual explicit Bootstrap step.
export async function POST(req: NextRequest) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const {
    name,
    gpuProviderId,
    gpuTypeId,
    gpuCount = 1,
    cloudType = "COMMUNITY",
    containerDiskGb = 50,
    volumeGb = 50,
    volumeMountPath = "/workspace",
    imageName,
    // "Instant cluster": launch from the pre-baked slurm-node image so the pod
    // comes up with Slurm already running (no separate apt Bootstrap step) and
    // the cluster goes ACTIVE directly. Opt-in (the wizard's "Instant Cluster"
    // tile sends instant=true). Default OFF preserves the legacy "RunPod GPU
    // pod" flow: bare runpod/pytorch image + manual Bootstrap.
    instant = false,
    sshKeyId,
  } = await req.json();

  // Server picks the image: an explicit imageName wins, otherwise instant pods
  // get the slurm-node image and legacy pods get runpod/pytorch.
  const effectiveImage =
    typeof imageName === "string" && imageName.trim()
      ? imageName.trim()
      : instant
        ? DEFAULT_SLURM_NODE_IMAGE
        : DEFAULT_RUNPOD_IMAGE;
  // Private ECR pulls need a RunPod registry credential id; public images don't.
  const containerRegistryAuthId = process.env.RUNPOD_REGISTRY_AUTH_ID || undefined;

  // Instant clusters are forced onto SECURE cloud (verified hosts) and onto
  // hosts that support CUDA >= 12.8 (the slurm-node image bundles CUDA 12.8).
  // The legacy "RunPod GPU pod" path keeps the user's cloud choice and no CUDA
  // filter (any CUDA host).
  const effectiveCloudType = instant ? "SECURE" : cloudType;
  const allowedCudaVersions = instant ? SLURM_NODE_CUDA_VERSIONS : undefined;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!gpuProviderId || !gpuTypeId || !sshKeyId) {
    return NextResponse.json({ error: "gpuProviderId, gpuTypeId and sshKeyId are required" }, { status: 400 });
  }
  if (!["COMMUNITY", "SECURE"].includes(cloudType)) {
    return NextResponse.json({ error: "cloudType must be COMMUNITY or SECURE" }, { status: 400 });
  }
  const count = parseInt(String(gpuCount), 10);
  if (!Number.isFinite(count) || count < 1 || count > 8) {
    return NextResponse.json({ error: "gpuCount must be between 1 and 8" }, { status: 400 });
  }
  const diskGb = parseInt(String(containerDiskGb), 10);
  if (!Number.isFinite(diskGb) || diskGb < 10 || diskGb > 1000) {
    return NextResponse.json({ error: "containerDiskGb must be between 10 and 1000" }, { status: 400 });
  }
  const volGb = parseInt(String(volumeGb), 10);
  if (!Number.isFinite(volGb) || volGb < 0 || volGb > 4000) {
    return NextResponse.json({ error: "volumeGb must be between 0 and 4000 (0 = no volume)" }, { status: 400 });
  }
  const mountPath = String(volumeMountPath || "/workspace").trim();
  if (volGb > 0 && !mountPath.startsWith("/")) {
    return NextResponse.json({ error: "volumeMountPath must be an absolute path" }, { status: 400 });
  }

  const existing = await prisma.cluster.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: `Cluster "${name}" already exists` }, { status: 409 });
  }

  const provider = await prisma.gpuProvider.findUnique({ where: { id: gpuProviderId } });
  if (!provider) return NextResponse.json({ error: "GPU provider not found" }, { status: 404 });
  if (provider.kind !== "runpod") {
    return NextResponse.json({ error: `Provider kind "${provider.kind}" is not supported yet` }, { status: 400 });
  }

  const sshKey = await prisma.sshKey.findUnique({ where: { id: sshKeyId } });
  if (!sshKey) return NextResponse.json({ error: "SSH key not found" }, { status: 404 });

  // Rent the pod first — if RunPod refuses (no stock, bad disk size, ...)
  // nothing lands in our DB. The key's public half goes in via PUBLIC_KEY,
  // which the runpod/pytorch start.sh appends to authorized_keys.
  const podName = `aura-${name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.slice(0, 60);
  let podId: string;
  try {
    podId = await createRunPodPod(provider.apiKey, {
      name: podName,
      imageName: effectiveImage,
      gpuTypeId,
      gpuCount: count,
      cloudType: effectiveCloudType,
      containerDiskInGb: diskGb,
      volumeInGb: volGb,
      volumeMountPath: mountPath,
      publicKey: sshKey.publicKey,
      containerRegistryAuthId,
      allowedCudaVersions,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "RunPod pod create failed" }, { status: 502 });
  }

  const cluster = await prisma.cluster.create({
    data: {
      name: name.trim(),
      // Filled in by the provisioning task once RunPod assigns the endpoint.
      controllerHost: "",
      connectionMode: "SSH",
      natsUrl: null,
      natsCredentials: "",
      sshUser: "root",
      sshPort: 22,
      status: "PROVISIONING",
      sshKeyId,
      config: {
        slurm_cluster_name: name.trim(),
        runpod: {
          providerId: provider.id,
          podId,
          gpuTypeId,
          gpuCount: count,
          cloudType: effectiveCloudType,
          imageName: effectiveImage,
          instant: !!instant,
          ...(allowedCudaVersions ? { allowedCudaVersions } : {}),
          containerDiskGb: diskGb,
          volumeGb: volGb,
          volumeMountPath: mountPath,
        },
        // Fixed Slurm/munge IDs baked into the slurm-node image, recorded so a
        // future add-node from the same image stays UID-aligned.
        ...(instant
          ? { slurm_uid: 5001, slurm_gid: 5001, munge_uid: 5002, munge_gid: 5002 }
          : {}),
      },
    },
  });

  const task = await prisma.backgroundTask.create({
    data: { clusterId: cluster.id, type: "runpod_provision", status: "running", logs: "" },
  });

  // Fire-and-forget — the UI polls /api/tasks/{taskId} for progress.
  runRunpodProvision(task.id, cluster.id).catch(() => {});

  await logAudit({
    action: "cluster.create",
    entity: "Cluster",
    entityId: cluster.id,
    metadata: { name: cluster.name, source: "runpod", gpuProvider: provider.name, runpodPodId: podId, gpuTypeId, gpuCount: count },
  });

  return NextResponse.json({ id: cluster.id, taskId: task.id }, { status: 201 });
}
