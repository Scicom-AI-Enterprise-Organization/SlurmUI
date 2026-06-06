// GPU cloud provider helpers. RunPod is the only kind for now; the shape
// (kind string + per-kind test/list functions) leaves room for more
// providers (Prime Intellect, Lambda, ...) without schema changes.
//
// RunPod has two APIs: REST at rest.runpod.io/v1 (pods CRUD) and GraphQL at
// api.runpod.io/graphql. GPU listings (stock + price) are GraphQL-only —
// the REST /v1/* surface doesn't expose them. Both accept the same
// `Authorization: Bearer <key>` header.

const RUNPOD_REST_BASE = (process.env.RUNPOD_API_BASE ?? "https://rest.runpod.io/v1").replace(/\/$/, "");
const RUNPOD_GRAPHQL_URL = process.env.RUNPOD_GRAPHQL_URL ?? "https://api.runpod.io/graphql";

export const GPU_PROVIDER_KINDS = ["runpod"] as const;
export type GpuProviderKind = (typeof GPU_PROVIDER_KINDS)[number];

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  accountId?: string;
  accountEmail?: string;
}

export interface GpuTypeInfo {
  id: string;
  displayName: string;
  memoryInGb: number | null;
  secureCloud: boolean;
  communityCloud: boolean;
  stockStatus: string | null; // "High" | "Medium" | "Low" | null (null = out of stock)
  pricePerHr: number | null; // on-demand (uninterruptable)
  spotPricePerHr: number | null; // spot (minimum bid)
}

export async function testGpuProviderKey(kind: string, apiKey: string): Promise<ProviderTestResult> {
  if (kind === "runpod") return testRunPodKey(apiKey);
  return { ok: false, message: `Unknown provider kind "${kind}"` };
}

// Cheap GET that succeeds on any valid RunPod key — lists 1 pod, which is
// authorised regardless of whether the account has pods. Account id/email
// are then fetched best-effort via GraphQL `myself` (restricted keys may
// not be allowed to read it; that shouldn't fail validation).
async function testRunPodKey(apiKey: string): Promise<ProviderTestResult> {
  let res: Response;
  try {
    res = await fetch(`${RUNPOD_REST_BASE}/pods?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err: any) {
    return { ok: false, message: `Could not reach RunPod: ${err?.message ?? err}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: "Unauthorized — check the API key" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      message: `RunPod returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }

  const result: ProviderTestResult = { ok: true, message: "Connected" };
  try {
    const data = await runpodGraphql(apiKey, "query { myself { id email } }");
    const myself = data?.myself;
    if (myself?.id) result.accountId = String(myself.id);
    if (myself?.email) {
      result.accountEmail = String(myself.email);
      result.message = `Connected as ${myself.email}`;
    }
  } catch {
    // best-effort only — the REST check above already proved the key works
  }
  return result;
}

// Full GPU catalogue with live stock + pricing for 1× GPU. Same query shape
// the RunPod console uses; stockStatus is null when the type is out of stock.
export async function listRunPodGpuTypes(apiKey: string): Promise<GpuTypeInfo[]> {
  const query = `
    query GpuTypes {
      gpuTypes {
        id
        displayName
        memoryInGb
        secureCloud
        communityCloud
        lowestPrice(input: { gpuCount: 1 }) {
          stockStatus
          uninterruptablePrice
          minimumBidPrice
        }
      }
    }`;
  const data = await runpodGraphql(apiKey, query);
  const types = Array.isArray(data?.gpuTypes) ? data.gpuTypes : [];
  return types
    .filter((t: any) => t?.id && t.id !== "unknown")
    .map((t: any): GpuTypeInfo => ({
      id: String(t.id),
      displayName: String(t.displayName ?? t.id),
      memoryInGb: typeof t.memoryInGb === "number" ? t.memoryInGb : null,
      secureCloud: !!t.secureCloud,
      communityCloud: !!t.communityCloud,
      stockStatus: t.lowestPrice?.stockStatus ?? null,
      pricePerHr: t.lowestPrice?.uninterruptablePrice ?? null,
      spotPricePerHr: t.lowestPrice?.minimumBidPrice ?? null,
    }));
}

// Default pod image for RunPod-backed clusters. The runpod/pytorch images'
// start.sh launches sshd and appends $PUBLIC_KEY to ~/.ssh/authorized_keys,
// which is the whole SSH contract we rely on.
export const DEFAULT_RUNPOD_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";

// Pre-baked Slurm-node image for "instant cluster" RunPod pods. Built from
// docker/slurm-node (FROM runpod/pytorch + slurm-wlm/munge/mariadb/chrony with
// fixed UIDs and a self-configuring entrypoint), so the pod comes up with Slurm
// already running, no apt bootstrap step. Built and pushed MANUALLY to ECR
// Public (anonymous pull, so RunPod needs no registry credentials); see
// docker/slurm-node/README.md. Override with AURA_SLURM_NODE_IMAGE if needed.
export const DEFAULT_SLURM_NODE_IMAGE =
  process.env.AURA_SLURM_NODE_IMAGE ??
  "public.ecr.aws/o6x1g6b0/slurm-node:latest";

// The slurm-node image is built FROM runpod/pytorch cu1281 → it bundles CUDA
// 12.8. A RunPod GPU host must therefore have a driver supporting CUDA >= 12.8
// for the container to run. RunPod's allowedCudaVersions filters by the host's
// supported CUDA version; list 12.8 and newer (CUDA is backward-compatible, so
// a 12.9/13.0 host runs a 12.8 container — don't exclude them).
export const SLURM_NODE_CUDA_VERSIONS = ["13.0", "12.9", "12.8"];

export interface CreateRunPodPodOpts {
  name: string;
  imageName: string;
  gpuTypeId: string; // RunPod GPU type id, e.g. "NVIDIA H100 80GB HBM3"
  gpuCount: number;
  cloudType: "COMMUNITY" | "SECURE";
  // RunPod pods have two disks: the container disk (ephemeral — wiped on
  // every pod restart) and an optional network volume (persists across
  // restarts, mounted at volumeMountPath, /workspace by convention).
  containerDiskInGb: number;
  volumeInGb: number; // 0 = no persistent volume
  volumeMountPath: string;
  publicKey: string; // OpenSSH public key appended to authorized_keys by start.sh
  // Optional RunPod container-registry credential id, needed to pull a PRIVATE
  // image (e.g. the slurm-node image from private ECR). Created once in the
  // RunPod account and referenced by id. Omit for public images (anonymous pull).
  containerRegistryAuthId?: string;
  // Optional list of acceptable host CUDA versions (e.g. ["13.0","12.9","12.8"]).
  // Restricts the pod to hosts whose driver supports one of these. Omit = any.
  allowedCudaVersions?: string[];
}

// Create a pod with SSH exposed. "22/tcp" asks RunPod for a public TCP port
// mapped to the container's sshd; the (ip, port) pair lands in portMappings
// once the pod is running. Returns the RunPod pod id.
export async function createRunPodPod(apiKey: string, opts: CreateRunPodPodOpts): Promise<string> {
  const res = await fetch(`${RUNPOD_REST_BASE}/pods`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: opts.name,
      imageName: opts.imageName,
      gpuTypeIds: [opts.gpuTypeId],
      gpuCount: opts.gpuCount,
      cloudType: opts.cloudType,
      containerDiskInGb: opts.containerDiskInGb,
      volumeInGb: opts.volumeInGb,
      ...(opts.volumeInGb > 0 ? { volumeMountPath: opts.volumeMountPath } : {}),
      // Aura manages the cluster over inbound SSH, so the pod MUST land on
      // a host that can map a public TCP port. Without this flag community
      // pods can land on hosts with no public IP — the pod runs fine but
      // "22/tcp" never gets an endpoint and provisioning times out.
      supportPublicIp: true,
      ports: ["22/tcp"],
      env: { PUBLIC_KEY: opts.publicKey },
      ...(opts.containerRegistryAuthId
        ? { containerRegistryAuthId: opts.containerRegistryAuthId }
        : {}),
      ...(opts.allowedCudaVersions?.length
        ? { allowedCudaVersions: opts.allowedCudaVersions }
        : {}),
    }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`RunPod pod create failed (HTTP ${res.status})${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const pod = body ? JSON.parse(body) : {};
  if (!pod?.id) throw new Error("RunPod pod create returned no pod id");
  return String(pod.id);
}

export async function getRunPodPod(apiKey: string, podId: string): Promise<any> {
  const res = await fetch(`${RUNPOD_REST_BASE}/pods/${encodeURIComponent(podId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RunPod pod fetch failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

// Best-effort terminate; a 404 means the pod is already gone — fine.
export async function terminateRunPodPod(apiKey: string, podId: string): Promise<void> {
  const res = await fetch(`${RUNPOD_REST_BASE}/pods/${encodeURIComponent(podId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`RunPod pod terminate failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

// Pull the public-IP / SSH-port pair out of a RunPod pod object. RunPod
// returns portMappings as either a dict {"22": 39342} (current REST shape)
// or a list of {privatePort, publicPort} records (older shape); GraphQL's
// legacy field is runtime.ports. Be defensive about all three. Returns
// nulls while SSH isn't assigned yet.
export function extractRunPodSshEndpoint(pod: any): { ip: string | null; port: number | null } {
  const publicIp: string | null = pod?.publicIp ?? pod?.public_ip ?? null;
  const pms = pod?.portMappings;

  if (pms && typeof pms === "object" && !Array.isArray(pms)) {
    for (const [k, v] of Object.entries(pms)) {
      if (parseInt(k, 10) === 22 && v) return { ip: publicIp, port: Number(v) };
    }
  }

  if (Array.isArray(pms)) {
    for (const pm of pms) {
      if (!pm || typeof pm !== "object") continue;
      const priv = pm.privatePort ?? pm.private_port;
      const proto = String(pm.type ?? pm.protocol ?? "").toLowerCase();
      const pub = pm.publicPort ?? pm.public_port;
      if (priv === 22 && (proto === "" || proto === "tcp") && pub) {
        return { ip: pm.ip ?? publicIp, port: Number(pub) };
      }
    }
  }

  for (const p of pod?.runtime?.ports ?? []) {
    if (!p || typeof p !== "object") continue;
    const priv = p.privatePort ?? p.private_port;
    const pub = p.publicPort ?? p.public_port;
    if (priv === 22 && String(p.type ?? "tcp").toLowerCase() === "tcp" && pub) {
      return { ip: p.ip ?? publicIp, port: Number(pub) };
    }
  }

  return { ip: publicIp, port: null };
}

async function runpodGraphql(apiKey: string, query: string): Promise<any> {
  const res = await fetch(RUNPOD_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RunPod GraphQL returned HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.errors?.length) throw new Error(payload.errors[0]?.message ?? "GraphQL error");
  return payload.data;
}
