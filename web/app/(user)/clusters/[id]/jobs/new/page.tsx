"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScriptEditor } from "@/components/jobs/script-editor";
import { toast } from "sonner";
import { Send, Sparkles, ChevronDown, X, Check } from "lucide-react";

const FORM_EXAMPLES = {
  nccl: {
    jobName: "nccl-allreduce",
    nodes: 2,
    ntasks: 2,
    ntasksPerNode: 1,
    cpusPerTask: 4,
    gpus: 1,
    memoryGb: 8,
    time: "00:10:00",
    command: `# Multi-node PyTorch all-reduce over NCCL (GPU).
# One task per node; each rank uses the local GPU.
echo "[launcher] $(date -u +%H:%M:%S) sbatch host=$(hostname) nodelist=$SLURM_JOB_NODELIST"
# Resolve the master's routable IP (Ubuntu's /etc/hosts maps hostname to
# 127.0.1.1, which breaks multi-node rendezvous).
MASTER_HOST=$(scontrol show hostnames $SLURM_JOB_NODELIST | head -1)
export MASTER_ADDR=$(srun -N1 -n1 -w $MASTER_HOST bash -c "hostname -I | awk '{print \\\$1}'")
export MASTER_PORT=29500
echo "[launcher] MASTER_ADDR=$MASTER_ADDR MASTER_PORT=$MASTER_PORT"

# Optional: activate the shared venv set up under Settings -> Python.
# Uncomment and set the right path for your cluster:
# source /mnt/shared/aura-venv/bin/activate   # shared mode
# source /opt/aura-venv/bin/activate          # per-node mode

srun --ntasks=\${SLURM_NTASKS} --ntasks-per-node=1 bash -c '
echo "[srun] $(date -u +%H:%M:%S) rank=$SLURM_PROCID host=$(hostname) gpu_id=$SLURM_LOCALID"
python3 -u - <<PY
import os, socket, torch, torch.distributed as dist

rank = int(os.environ["SLURM_PROCID"])
world = int(os.environ["SLURM_NTASKS"])
local_rank = int(os.environ.get("SLURM_LOCALID", 0))

os.environ["RANK"] = str(rank)
os.environ["WORLD_SIZE"] = str(world)
os.environ["LOCAL_RANK"] = str(local_rank)

print(f"[rank {rank}] host={socket.gethostname()} local_rank={local_rank}", flush=True)
print(f"[rank {rank}] CUDA available: {torch.cuda.is_available()}", flush=True)
print(f"[rank {rank}] CUDA_VISIBLE_DEVICES=" + os.environ.get("CUDA_VISIBLE_DEVICES", "<unset>"), flush=True)
print(f"[rank {rank}] device count: {torch.cuda.device_count()}", flush=True)
for i in range(torch.cuda.device_count()):
    p = torch.cuda.get_device_properties(i)
    print(f"[rank {rank}]   cuda:{i}  {p.name}  {p.total_memory // (1024*1024)} MiB  SM={p.major}.{p.minor}", flush=True)
print(f"[rank {rank}] torch={torch.__version__}  cuda={torch.version.cuda}  nccl={torch.cuda.nccl.version() if torch.cuda.is_available() else None}", flush=True)

torch.cuda.set_device(local_rank)
dist.init_process_group(backend="nccl")

t = torch.full((4,), float(rank), device=f"cuda:{local_rank}")
print(f"[rank {rank}] before:", t.tolist(), flush=True)
dist.all_reduce(t, op=dist.ReduceOp.SUM)
print(f"[rank {rank}] after :", t.tolist(), flush=True)

dist.destroy_process_group()
PY
'`,
  },
  gloo: {
    jobName: "gloo-allreduce",
    nodes: 2,
    ntasks: 2,
    ntasksPerNode: 1,
    cpusPerTask: 2,
    gpus: 0,
    memoryGb: 4,
    time: "00:10:00",
    command: `# Multi-node PyTorch all-reduce over Gloo (CPU).
# Resolve the master's *routable* IP rather than its hostname — Ubuntu cloud
# images map "hostname" to 127.0.1.1 in /etc/hosts, which breaks Gloo.
MASTER_HOST=$(scontrol show hostnames $SLURM_JOB_NODELIST | head -1)
export MASTER_ADDR=$(srun -N1 -n1 -w $MASTER_HOST bash -c "hostname -I | awk '{print \\\$1}'")
export MASTER_PORT=29500
echo "[launcher] MASTER_ADDR=$MASTER_ADDR (resolved from $MASTER_HOST)"

srun --ntasks=\${SLURM_NTASKS} --ntasks-per-node=1 bash -c '
python3 - <<PY
import os, torch, torch.distributed as dist

rank = int(os.environ["SLURM_PROCID"])
world = int(os.environ["SLURM_NTASKS"])
os.environ["RANK"] = str(rank)
os.environ["WORLD_SIZE"] = str(world)

dist.init_process_group(backend="gloo")
t = torch.full((4,), float(rank))
print(f"[rank {rank}] before:", t.tolist(), flush=True)
dist.all_reduce(t, op=dist.ReduceOp.SUM)
print(f"[rank {rank}] after :", t.tolist(), flush=True)
dist.destroy_process_group()
PY
'`,
  },
  echo: {
    jobName: "hello",
    nodes: 1,
    ntasks: 1,
    cpusPerTask: 1,
    gpus: 0,
    memoryGb: 1,
    time: "00:05:00",
    command: `echo "Hello from $(hostname)"
echo "Job started at $(date)"
sleep 5
echo "Done at $(date)"`,
  },
  torchrun: {
    jobName: "torch-train",
    nodes: 1,
    ntasks: 1,
    ntasksPerNode: 1,
    cpusPerTask: 8,
    gpus: 2,
    memoryGb: 64,
    time: "1-00:00:00",
    command: `torchrun \\
  --nproc_per_node=\${SLURM_GPUS_ON_NODE:-2} \\
  --nnodes=\${SLURM_NNODES:-1} \\
  --node_rank=\${SLURM_NODEID:-0} \\
  train.py \\
  --model_name your-model \\
  --batch_size 8 \\
  --epochs 3`,
  },
  vllm: {
    jobName: "vllm-serve",
    nodes: 1,
    ntasks: 1,
    ntasksPerNode: 1,
    cpusPerTask: 4,
    gpus: 2,
    memoryGb: 64,
    time: "0",
    command: `vllm serve your-27b-model \\
  --tensor-parallel-size 2 \\
  --dtype float16 \\
  --host 0.0.0.0 \\
  --port 8000 \\
  --gpu-memory-utilization 0.85`,
  },
} as const;

const RAW_EXAMPLES = {
  nccl: (partition: string) => `#!/bin/bash
#SBATCH --job-name=nccl-allreduce
#SBATCH --partition=${partition || "gpu"}
#SBATCH --nodes=2
#SBATCH --ntasks=2
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --gres=gpu:1
#SBATCH --mem=8G
#SBATCH --time=00:10:00

echo "[launcher] $(date -u +%H:%M:%S) sbatch host=$(hostname) nodelist=$SLURM_JOB_NODELIST"
export MASTER_ADDR=$(scontrol show hostnames $SLURM_JOB_NODELIST | head -1)
export MASTER_PORT=29500
echo "[launcher] MASTER_ADDR=$MASTER_ADDR MASTER_PORT=$MASTER_PORT"

# Optional: activate the shared venv set up under Settings -> Python.
# source /mnt/shared/aura-venv/bin/activate   # shared mode
# source /opt/aura-venv/bin/activate          # per-node mode

srun --ntasks=$SLURM_NTASKS --ntasks-per-node=1 bash -c '
echo "[srun] $(date -u +%H:%M:%S) rank=$SLURM_PROCID host=$(hostname) gpu_id=$SLURM_LOCALID"
python3 -u - <<PY
import os, socket, torch, torch.distributed as dist

rank = int(os.environ["SLURM_PROCID"])
world = int(os.environ["SLURM_NTASKS"])
local_rank = int(os.environ.get("SLURM_LOCALID", 0))

os.environ["RANK"] = str(rank)
os.environ["WORLD_SIZE"] = str(world)
os.environ["LOCAL_RANK"] = str(local_rank)

print(f"[rank {rank}] host={socket.gethostname()} local_rank={local_rank}", flush=True)
print(f"[rank {rank}] CUDA available: {torch.cuda.is_available()}", flush=True)
print(f"[rank {rank}] CUDA_VISIBLE_DEVICES=" + os.environ.get("CUDA_VISIBLE_DEVICES", "<unset>"), flush=True)
print(f"[rank {rank}] device count: {torch.cuda.device_count()}", flush=True)
for i in range(torch.cuda.device_count()):
    p = torch.cuda.get_device_properties(i)
    print(f"[rank {rank}]   cuda:{i}  {p.name}  {p.total_memory // (1024*1024)} MiB  SM={p.major}.{p.minor}", flush=True)
print(f"[rank {rank}] torch={torch.__version__}  cuda={torch.version.cuda}  nccl={torch.cuda.nccl.version() if torch.cuda.is_available() else None}", flush=True)

torch.cuda.set_device(local_rank)
dist.init_process_group(backend="nccl")

t = torch.full((4,), float(rank), device=f"cuda:{local_rank}")
print(f"[rank {rank}] before:", t.tolist(), flush=True)
dist.all_reduce(t, op=dist.ReduceOp.SUM)
print(f"[rank {rank}] after :", t.tolist(), flush=True)

dist.destroy_process_group()
PY
'
`,
  gloo: (partition: string) => `#!/bin/bash
#SBATCH --job-name=gloo-allreduce
#SBATCH --partition=${partition || "main"}
#SBATCH --nodes=2
#SBATCH --ntasks=2
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=00:10:00

# All ranks need to agree on MASTER_ADDR — use the first allocated node.
export MASTER_ADDR=$(scontrol show hostnames $SLURM_JOB_NODELIST | head -1)
export MASTER_PORT=29500

srun --ntasks=$SLURM_NTASKS --ntasks-per-node=1 bash -c '
python3 - <<PY
import os, torch, torch.distributed as dist

rank = int(os.environ["SLURM_PROCID"])
world = int(os.environ["SLURM_NTASKS"])

os.environ["RANK"] = str(rank)
os.environ["WORLD_SIZE"] = str(world)

dist.init_process_group(backend="gloo")
t = torch.full((4,), float(rank))
print(f"[rank {rank}] before:", t.tolist(), flush=True)
dist.all_reduce(t, op=dist.ReduceOp.SUM)
print(f"[rank {rank}] after :", t.tolist(), flush=True)
dist.destroy_process_group()
PY
'
`,
  echo: (partition: string) => `#!/bin/bash
#SBATCH --job-name=hello
#SBATCH --partition=${partition || "main"}
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --mem=1G
#SBATCH --time=00:05:00

echo "Hello from $(hostname)"
echo "Job started at $(date)"
sleep 5
echo "Done at $(date)"
`,
  torchrun: (partition: string) => `#!/bin/bash
#SBATCH --job-name=torch-train
#SBATCH --partition=${partition || "gpu"}
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:2
#SBATCH --mem=64G
#SBATCH --time=1-00:00:00

torchrun \\
  --nproc_per_node=\${SLURM_GPUS_ON_NODE:-2} \\
  --nnodes=\${SLURM_NNODES:-1} \\
  --node_rank=\${SLURM_NODEID:-0} \\
  train.py \\
  --model_name your-model \\
  --batch_size 8 \\
  --epochs 3
`,
  vllm: (partition: string) => `#!/bin/bash
#SBATCH --job-name=vllm-serve
#SBATCH --partition=${partition || "gpu"}
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --gres=gpu:2
#SBATCH --mem=64G
#SBATCH --time=0

vllm serve your-27b-model \\
  --tensor-parallel-size 2 \\
  --dtype float16 \\
  --host 0.0.0.0 \\
  --port 8000 \\
  --gpu-memory-utilization 0.85
`,
};


interface ParsedSbatch {
  jobName?: string;
  nodes?: number;
  ntasks?: number;
  ntasksPerNode?: number;
  cpusPerTask?: number;
  gpus?: number;
  memoryGb?: number;
  time?: string;
  arraySpec?: string;
  partition?: string;
  chdir?: string;
  nodelist?: string[];
  command?: string;
}

function parseSbatchScript(script: string): ParsedSbatch {
  const out: ParsedSbatch = {};
  const lines = script.split("\n");
  let commandStart = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (i === 0 && trimmed.startsWith("#!")) continue;
    if (trimmed === "") continue;
    const sbatch = trimmed.match(/^#SBATCH\s+(.+)$/);
    if (!sbatch) {
      if (trimmed.startsWith("#")) continue; // other comments before the body
      commandStart = i;
      break;
    }
    // Split "--key=val", "--key val", "-X val", "-Xval"
    const body = sbatch[1].trim();
    let key: string, val: string;
    const eq = body.match(/^(--[a-zA-Z-]+|-[a-zA-Z])=(.+)$/);
    if (eq) {
      key = eq[1]; val = eq[2];
    } else {
      const sp = body.match(/^(--[a-zA-Z-]+|-[a-zA-Z])\s+(.+)$/);
      if (sp) { key = sp[1]; val = sp[2]; }
      else continue;
    }
    val = val.trim();
    switch (key) {
      case "--job-name": case "-J": out.jobName = val; break;
      case "--nodes": case "-N": out.nodes = parseInt(val, 10) || 1; break;
      case "--ntasks": case "-n": out.ntasks = parseInt(val, 10) || 1; break;
      case "--ntasks-per-node": out.ntasksPerNode = parseInt(val, 10) || 0; break;
      case "--cpus-per-task": case "-c": out.cpusPerTask = parseInt(val, 10) || 1; break;
      case "--gres": {
        const m = val.match(/gpu(?::[^:]+)?:(\d+)/);
        if (m) out.gpus = parseInt(m[1], 10) || 0;
        break;
      }
      case "--mem": {
        const m = val.match(/^(\d+)\s*([GgMm])?/);
        if (m) {
          const n = parseInt(m[1], 10);
          const unit = (m[2] ?? "M").toUpperCase();
          out.memoryGb = unit === "G" ? n : Math.round(n / 1024);
        }
        break;
      }
      case "--time": case "-t": out.time = val; break;
      case "--array": case "-a": out.arraySpec = val; break;
      case "--partition": case "-p": out.partition = val; break;
      case "--chdir": case "-D": out.chdir = val; break;
      case "--nodelist": case "-w": {
        // Slurm expands "gpu[1-3]" ranges but users also paste plain comma
        // lists — we only handle the latter; ranges pass through unchanged.
        out.nodelist = val.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
    }
  }

  out.command = lines.slice(commandStart).join("\n").replace(/^\s+/, "");
  return out;
}

export default function NewJobPage() {
  const params = useParams();
  const router = useRouter();
  const clusterId = params.id as string;

  // Form mode state
  const [jobName, setJobName] = useState("");
  const [nodes, setNodes] = useState(1);
  const [ntasks, setNtasks] = useState(1);
  const [ntasksPerNode, setNtasksPerNode] = useState(0);
  const [cpusPerTask, setCpusPerTask] = useState(1);
  const [gpus, setGpus] = useState(0);
  const [memoryGb, setMemoryGb] = useState(0);
  const [time, setTime] = useState(""); // e.g. "1-00:00:00" or "" for unlimited
  const [arraySpec, setArraySpec] = useState(""); // e.g. "1-100", "0-99:2", "1-16%4"
  const [command, setCommand] = useState("");

  // Raw mode state
  const [rawScript, setRawScript] = useState("");

  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string; detail?: string } | null>(null);

  const [mode, setMode] = useState<"form" | "raw">("form");
  const [partition, setPartition] = useState("");
  const [partitions, setPartitions] = useState<string[]>([]);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [availableNodes, setAvailableNodes] = useState<string[]>([]);
  const [nodesOpen, setNodesOpen] = useState(false);
  const nodelist = selectedNodes.join(",");
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; script: string; partition: string }>>([]);
  const [storage, setStorage] = useState("");
  const [storageMounts, setStorageMounts] = useState<Array<{ id: string; mountPath: string; type: string }>>([]);
  const [pythonVenvPath, setPythonVenvPath] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [gitopsOnly, setGitopsOnly] = useState(false);

  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/gitops-only`)
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => setGitopsOnly(!!d.enabled))
      .catch(() => {});
  }, [clusterId]);

  useEffect(() => {
    fetch(`/api/clusters/${clusterId}`)
      .then((res) => res.json())
      .then((cluster) => {
        const config = cluster.config as Record<string, unknown>;
        const parts = (config.slurm_partitions ?? []) as Array<{ name: string; default?: boolean }>;
        const nodeCount = ((config.slurm_hosts_entries ?? []) as unknown[]).length;
        if (parts.length === 0 && nodeCount > 0) {
          setPartitions(["main"]);
          setPartition("main");
        } else {
          setPartitions(parts.map((p) => p.name));
          const defaultPart = parts.find((p) => p.default);
          if (defaultPart) setPartition(defaultPart.name);
          else if (parts.length > 0) setPartition(parts[0].name);
        }

        const mounts = (config.storage_mounts ?? []) as Array<{ id: string; mountPath: string; type: string }>;
        setStorageMounts(mounts);
        // /opt is root-only on most distros — slurmd can't cd into it as the
        // submitting user and the job dies before it starts. /tmp is world-
        // writable and exists on every node, so it's a safe default when no
        // shared storage mount is configured.
        setStorage(mounts.length > 0 ? mounts[0].mountPath : "/tmp");

        // Compute the python venv path from Python Packages settings.
        // Per-node mode: python_local_venv_path is the venv itself.
        // Shared mode:   python_venv_location holds the parent dir — venv is at "<loc>/aura-venv".
        // Prefer whichever is populated so stale install_mode fields don't hide the path.
        const pyMode = (config.python_install_mode as string) ?? "";
        const localPath = ((config.python_local_venv_path as string) ?? "").trim();
        const sharedLoc = ((config.python_venv_location as string) ?? "").trim();
        let venv = "";
        if (pyMode === "per-node" && localPath) {
          venv = localPath;
        } else if (pyMode === "shared" && sharedLoc) {
          venv = `${sharedLoc.replace(/\/+$/, "")}/aura-venv`;
        } else if (localPath) {
          venv = localPath;
        } else if (sharedLoc) {
          venv = `${sharedLoc.replace(/\/+$/, "")}/aura-venv`;
        }
        setPythonVenvPath(venv.replace(/\/+$/, ""));
      })
      .catch(() => {});

    fetch(`/api/clusters/${clusterId}/resources`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const names = (d.nodes ?? []).map((n: { host: string }) => n.host).filter(Boolean);
        setAvailableNodes(names);
      })
      .catch(() => { /* endpoint only available on SSH clusters — silently skip */ });

    fetch(`/api/clusters/${clusterId}/templates`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => { /* no templates endpoint — skip */ });
  }, [clusterId]);

  const loadTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (mode === "raw") {
      setRawScript(t.script);
      if (t.partition) setPartition(t.partition);
      return;
    }
    // Form mode — parse SBATCH directives into the form fields, drop the
    // remainder into the Command textarea.
    const parsed = parseSbatchScript(t.script);
    if (parsed.jobName !== undefined) setJobName(parsed.jobName);
    if (parsed.nodes !== undefined) setNodes(parsed.nodes);
    if (parsed.ntasks !== undefined) setNtasks(parsed.ntasks);
    if (parsed.ntasksPerNode !== undefined) setNtasksPerNode(parsed.ntasksPerNode);
    if (parsed.cpusPerTask !== undefined) setCpusPerTask(parsed.cpusPerTask);
    if (parsed.gpus !== undefined) setGpus(parsed.gpus);
    if (parsed.memoryGb !== undefined) setMemoryGb(parsed.memoryGb);
    if (parsed.time !== undefined) setTime(parsed.time);
    if (parsed.arraySpec !== undefined) setArraySpec(parsed.arraySpec);
    if (parsed.partition) setPartition(parsed.partition);
    else if (t.partition) setPartition(t.partition);
    if (parsed.chdir) setStorage(parsed.chdir);
    if (parsed.nodelist && parsed.nodelist.length > 0) {
      setSelectedNodes(parsed.nodelist);
    }
    if (parsed.command !== undefined) setCommand(parsed.command);
  };

  const loadFormExample = (key: keyof typeof FORM_EXAMPLES) => {
    const ex = FORM_EXAMPLES[key] as typeof FORM_EXAMPLES[typeof key] & { ntasksPerNode?: number };
    setJobName(ex.jobName);
    setNodes(ex.nodes);
    setNtasks(ex.ntasks);
    setNtasksPerNode(ex.ntasksPerNode ?? 0);
    setCpusPerTask(ex.cpusPerTask);
    setGpus(ex.gpus);
    setMemoryGb(ex.memoryGb);
    setTime(ex.time);
    setCommand(ex.command);
  };

  const loadRawExample = (key: keyof typeof RAW_EXAMPLES) => {
    setRawScript(RAW_EXAMPLES[key](partition));
  };

  const buildScriptFromForm = (): string => {
    const lines: string[] = ["#!/bin/bash"];
    if (jobName.trim()) lines.push(`#SBATCH --job-name=${jobName.trim()}`);
    lines.push(`#SBATCH --partition=${partition}`);
    lines.push(`#SBATCH --nodes=${nodes}`);
    lines.push(`#SBATCH --ntasks=${ntasks}`);
    if (ntasksPerNode > 0) lines.push(`#SBATCH --ntasks-per-node=${ntasksPerNode}`);
    if (cpusPerTask > 1) lines.push(`#SBATCH --cpus-per-task=${cpusPerTask}`);
    if (gpus > 0) lines.push(`#SBATCH --gres=gpu:${gpus}`);
    if (memoryGb > 0) lines.push(`#SBATCH --mem=${memoryGb}G`);
    lines.push(`#SBATCH --time=${time.trim() || "0"}`);
    if (storage) lines.push(`#SBATCH --chdir=${storage}`);
    if (nodelist.trim()) lines.push(`#SBATCH --nodelist=${nodelist.trim()}`);
    if (arraySpec.trim()) lines.push(`#SBATCH --array=${arraySpec.trim()}`);
    // Omit --output/--error so Slurm writes to the submission dir (NFS home or
    // --chdir), which must live on shared storage so the controller can tail.
    lines.push("");
    lines.push(command);
    return lines.join("\n");
  };

  const handleSubmit = async () => {
    const script = mode === "form" ? buildScriptFromForm() : rawScript;
    if (mode === "form" && !command.trim()) {
      setErrorDialog({ title: "Missing command", message: "Please enter a command to run." });
      return;
    }
    if (mode === "raw" && !rawScript.trim()) {
      setErrorDialog({ title: "Missing script", message: "Please enter a job script." });
      return;
    }
    if (!partition) {
      setErrorDialog({ title: "Missing partition", message: "Please select a partition." });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, partition }),
      });

      if (res.ok || res.status === 201) {
        const job = await res.json();
        router.push(`/clusters/${clusterId}/jobs/${job.id}`);
      } else {
        const err = await res.json().catch(() => ({}));
        const raw = err.error ?? `Server returned ${res.status}`;
        // If the message is multi-line (e.g. sbatch stderr), put the first line
        // in the title summary and the full trace in the detail block.
        const nlIdx = raw.indexOf("\n");
        setErrorDialog({
          title: "Job submission failed",
          message: nlIdx === -1 ? raw : raw.slice(0, nlIdx),
          detail: nlIdx === -1 ? err.detail ?? err.stderr ?? err.output : raw,
        });
      }
    } catch (e) {
      setErrorDialog({
        title: "Job submission failed",
        message: "Network error — could not reach the cluster API.",
        detail: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Submit Job</h1>
        <p className="text-muted-foreground">Submit a Slurm batch job</p>
      </div>

      {gitopsOnly && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            This cluster is GitOps-only
          </p>
          <p className="mt-1 text-muted-foreground">
            Jobs can only be submitted via the <b>Git Jobs</b> reconciler. Commit a manifest
            under <code>jobs/**/*.yaml</code> with <code>metadata.cluster</code> set to this
            cluster's name and the reconciler will pick it up on the next tick. An admin
            can flip this off in <b>Cluster → Configuration → GitOps-only jobs</b>.
          </p>
        </div>
      )}

      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Partition</Label>
              <Select value={partition} onValueChange={(v) => { if (v !== null) setPartition(v); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a partition" />
                </SelectTrigger>
                <SelectContent>
                  {partitions.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Nodes (optional)</Label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setNodesOpen((o) => !o)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 min-h-10 text-sm shadow-xs hover:bg-accent"
                >
                  <span className="flex flex-wrap items-center gap-1 text-left min-w-0">
                    {selectedNodes.length === 0 ? (
                      <span className="text-muted-foreground">Any node in partition</span>
                    ) : (
                      selectedNodes.map((n) => (
                        <span
                          key={n}
                          role="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedNodes((s) => s.filter((x) => x !== n));
                          }}
                          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono hover:bg-destructive/20"
                        >
                          {n}<X className="h-3 w-3" />
                        </span>
                      ))
                    )}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </button>
                {nodesOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setNodesOpen(false)} />
                    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-md">
                      {availableNodes.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          No nodes returned — cluster may be non-SSH, offline, or still loading.
                        </div>
                      ) : (
                        availableNodes.map((n) => {
                          const checked = selectedNodes.includes(n);
                          return (
                            <button
                              type="button"
                              key={n}
                              onClick={() =>
                                setSelectedNodes((s) =>
                                  checked ? s.filter((x) => x !== n) : [...s, n]
                                )
                              }
                              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                            >
                              <span className="flex h-4 w-4 items-center justify-center rounded border">
                                {checked && <Check className="h-3 w-3" />}
                              </span>
                              <span className="font-mono">{n}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Pin the job to specific nodes (<code>--nodelist</code>). Leave empty to let Slurm pick.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Working Directory</Label>
              <Select
                value={storage}
                onValueChange={(v) => { if (v !== null) setStorage(v); }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a directory" />
                </SelectTrigger>
                <SelectContent>
                  {storageMounts.map((m) => (
                    <SelectItem key={m.id} value={m.mountPath}>
                      {m.mountPath} ({m.type})
                    </SelectItem>
                  ))}
                  <SelectItem value="/tmp">/tmp (local to each node, world-writable)</SelectItem>
                  <SelectItem value="/opt">/opt (local, root-only — only works if your user can write here)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Job runs from this directory. Output files land here.
                {storage === "/opt" && " Note: /opt is root-only on most distros — your user must have write access or the job will fail before it starts."}
                {storage === "/tmp" && " Note: /tmp is local per-node, so outputs on multi-node jobs only appear on the first allocated node."}
              </p>
            </div>
          </div>

          <Tabs value={mode} onValueChange={(v) => setMode(v as "form" | "raw")}>
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="raw">Raw Script</TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="space-y-4 mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> Examples:
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => loadFormExample("echo")}>
                  Hello world
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadFormExample("gloo")}>
                  Gloo all-reduce
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadFormExample("nccl")}>
                  NCCL GPU all-reduce
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadFormExample("torchrun")}>
                  Train with torchrun
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadFormExample("vllm")}>
                  Serve with vLLM
                </Button>
              </div>

              {templates.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">Load from template:</span>
                  <Select value="" onValueChange={loadTemplate}>
                    <SelectTrigger size="sm" className="h-8 w-64">
                      <SelectValue placeholder="Pick a saved template..." />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="job-name">Job Name</Label>
                <Input
                  id="job-name"
                  placeholder="e.g. vllm-serve"
                  value={jobName}
                  onChange={(e) => setJobName(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="nodes">Nodes</Label>
                  <Input
                    id="nodes"
                    type="number"
                    min={1}
                    value={nodes}
                    onChange={(e) => setNodes(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ntasks">Tasks</Label>
                  <Input
                    id="ntasks"
                    type="number"
                    min={1}
                    value={ntasks}
                    onChange={(e) => setNtasks(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ntasks-per-node">Tasks per node</Label>
                  <Input
                    id="ntasks-per-node"
                    type="number"
                    min={0}
                    value={ntasksPerNode}
                    onChange={(e) => setNtasksPerNode(Math.max(0, parseInt(e.target.value) || 0))}
                    placeholder="0 = let Slurm decide"
                  />
                  <p className="text-xs text-muted-foreground">
                    0 lets Slurm pack freely. Set to 1 for multi-node demos
                    (one rank per box, e.g. Gloo/NCCL all-reduce).
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cpus">CPUs per task</Label>
                  <Input
                    id="cpus"
                    type="number"
                    min={1}
                    value={cpusPerTask}
                    onChange={(e) => setCpusPerTask(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gpus">GPUs</Label>
                  <Input
                    id="gpus"
                    type="number"
                    min={0}
                    value={gpus}
                    onChange={(e) => setGpus(Math.max(0, parseInt(e.target.value) || 0))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mem">Memory (GB)</Label>
                  <Input
                    id="mem"
                    type="number"
                    min={0}
                    placeholder="0 = unlimited"
                    value={memoryGb}
                    onChange={(e) => setMemoryGb(Math.max(0, parseInt(e.target.value) || 0))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="time">Time limit</Label>
                  <Input
                    id="time"
                    placeholder="0 = unlimited, or 1-00:00:00"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="array">Array (optional)</Label>
                  <Input
                    id="array"
                    placeholder="1-100, 0-99:2, 1-16%4"
                    value={arraySpec}
                    onChange={(e) => setArraySpec(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Fan out into N tasks. <code>1-100</code> runs 100 copies, <code>%5</code> caps concurrency.
                    Refer to the array index with <code>$SLURM_ARRAY_TASK_ID</code> in your command.
                  </p>
                </div>
              </div>

              <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-2">
                <div className="font-medium text-foreground">Python venv</div>
                {pythonVenvPath ? (
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <code className="font-mono text-muted-foreground break-all">
                      source {pythonVenvPath}/bin/activate
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const line = `source ${pythonVenvPath}/bin/activate`;
                        setCommand(command ? `${line}\n\n${command}` : line);
                      }}
                    >
                      Insert into command
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    Not configured. Set up a shared venv under Settings → Python to get a ready-to-activate path here.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="command">Command</Label>
                <Textarea
                  id="command"
                  placeholder={`vllm serve your-model \\\n  --tensor-parallel-size 2`}
                  rows={10}
                  className="font-mono text-sm"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>

              {command && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Preview</Label>
                  <pre className="rounded-md border bg-muted p-3 text-xs font-mono overflow-x-auto">
                    {buildScriptFromForm()}
                  </pre>
                </div>
              )}
            </TabsContent>

            <TabsContent value="raw" className="space-y-4 mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> Examples:
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => loadRawExample("echo")}>
                  Hello world
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadRawExample("gloo")}>
                  Gloo all-reduce
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadRawExample("nccl")}>
                  NCCL GPU all-reduce
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadRawExample("torchrun")}>
                  Train with torchrun
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => loadRawExample("vllm")}>
                  Serve with vLLM
                </Button>
              </div>
              {templates.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">Load from template:</span>
                  <Select value="" onValueChange={loadTemplate}>
                    <SelectTrigger size="sm" className="h-8 w-64">
                      <SelectValue placeholder="Pick a saved template..." />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <ScriptEditor value={rawScript} onChange={setRawScript} />
            </TabsContent>
          </Tabs>

          <Button
            onClick={handleSubmit}
            disabled={gitopsOnly || submitting || !partition || (mode === "form" ? !command.trim() : !rawScript.trim())}
            className="w-full"
          >
            <Send className="mr-2 h-4 w-4" />
            {submitting ? "Submitting..." : "Submit Job"}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={!!errorDialog} onOpenChange={(o) => { if (!o) setErrorDialog(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-destructive">{errorDialog?.title}</DialogTitle>
            <DialogDescription>{errorDialog?.message}</DialogDescription>
          </DialogHeader>
          {errorDialog?.detail && (
            <pre className="max-h-96 overflow-y-auto rounded-md border bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
              {errorDialog.detail}
            </pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
