"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, ChevronRight, Loader2, Plus, Trash2, AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface NodeRow { hostname: string; ip: string; cpus: number; memoryMb: number; gpus: number }
interface Partition { name: string; nodes: string; maxTime: string; isDefault: boolean }

interface SetupStepperProps { clusterId: string; sshKeyConfigured: boolean }

type StepStatus = "pending" | "running" | "done" | "error";

interface StepState {
  status: StepStatus;
  logs: string[];
  error?: string;
}

function LogView({ lines, status }: { lines: string[]; status: StepStatus }) {
  return (
    <div className="mt-3 h-48 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400">
      {lines.length === 0 && <span className="text-gray-500">No output yet...</span>}
      {lines.map((l, i) => <div key={i} className="whitespace-pre-wrap leading-5">{l}</div>)}
      {status === "error" && <div className="mt-2 text-red-400">✗ Step failed</div>}
      {status === "done" && <div className="mt-2 text-green-300">✓ Step complete</div>}
    </div>
  );
}

async function runStreamingCommand(
  url: string,
  body: object,
  clusterId: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    onLine(`[error] ${err.error}`);
    return false;
  }
  const { request_id } = await res.json();

  return new Promise((resolve) => {
    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);
    evtSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") onLine(event.line);
        else if (event.type === "complete") {
          evtSource.close();
          resolve(event.success);
        }
      } catch {}
    };
    evtSource.onerror = () => { evtSource.close(); resolve(false); };
  });
}

export function SetupStepper({ clusterId, sshKeyConfigured }: SetupStepperProps) {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStates, setStepStates] = useState<StepState[]>([
    { status: "pending", logs: [] },
    { status: "pending", logs: [] },
    { status: "pending", logs: [] },
    { status: "pending", logs: [] },
  ]);

  // NFS form
  const [nfs, setNfs] = useState({ mgmtNfsServer: "", mgmtNfsPath: "/mgmt", dataNfsServer: "", dataNfsPath: "/aura-usrdata", nfsAllowedNetwork: "" });

  // Nodes form
  const [nodes, setNodes] = useState<NodeRow[]>([{ hostname: "", ip: "", cpus: 8, memoryMb: 16384, gpus: 0 }]);
  const [controllerIsWorker, setControllerIsWorker] = useState(false);

  // Partitions form
  const [partitions, setPartitions] = useState<Partition[]>([{ name: "compute", nodes: "", maxTime: "24:00:00", isDefault: true }]);

  const setStep = (idx: number, patch: Partial<StepState>) =>
    setStepStates((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const appendLog = (idx: number, line: string) =>
    setStepStates((prev) => prev.map((s, i) => (i === idx ? { ...s, logs: [...s.logs, line] } : s)));

  // Step 0: NFS
  const runNfs = async () => {
    setStep(0, { status: "running", logs: [] });
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/nfs`,
      nfs,
      clusterId,
      (line) => appendLog(0, line),
    );
    setStep(0, { status: ok ? "done" : "error" });
    if (ok) setCurrentStep(1);
  };

  // Step 1: Nodes
  const runNodes = async () => {
    setStep(1, { status: "running", logs: [] });
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/nodes`,
      { nodes: nodes.map((n) => ({ hostname: n.hostname, ip: n.ip, cpus: n.cpus, memory_mb: n.memoryMb, gpus: n.gpus })), controllerIsWorker },
      clusterId,
      (line) => appendLog(1, line),
    );
    setStep(1, { status: ok ? "done" : "error" });
    if (ok) setCurrentStep(2);
  };

  // Step 2: Partitions
  const runPartitions = async () => {
    setStep(2, { status: "running", logs: [] });
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/partitions`,
      { partitions: partitions.map((p) => ({ name: p.name, nodes: p.nodes, max_time: p.maxTime, default: p.isDefault })) },
      clusterId,
      (line) => appendLog(2, line),
    );
    setStep(2, { status: ok ? "done" : "error" });
    if (ok) setCurrentStep(3);
  };

  // Step 3: Health check — after success, PATCH cluster to ACTIVE
  const runHealth = async () => {
    setStep(3, { status: "running", logs: [] });
    appendLog(3, "[aura] Running health check (sinfo)...");
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/health`,
      {},
      clusterId,
      (line) => appendLog(3, line),
    );
    if (ok) {
      appendLog(3, "[aura] Health check passed. Marking cluster ACTIVE...");
      await fetch(`/api/clusters/${clusterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" }),
      });
      appendLog(3, "[aura] Cluster is now ACTIVE");
      setStep(3, { status: "done" });
      setTimeout(() => router.refresh(), 1500);
    } else {
      appendLog(3, "[error] Health check failed");
      setStep(3, { status: "error" });
    }
  };

  const stepTitles = ["NFS Storage", "Nodes", "Partitions", "Health Check"];

  if (!sshKeyConfigured) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-5 space-y-3">
        <div className="flex items-center gap-2 text-destructive font-semibold">
          <AlertTriangle className="h-5 w-5" />
          SSH key not configured
        </div>
        <p className="text-sm text-muted-foreground">
          An SSH key is required before nodes can be provisioned. Aura uses it to reach cluster
          nodes via Ansible.
        </p>
        <ol className="text-sm space-y-1 list-decimal list-inside text-muted-foreground">
          <li>
            Go to{" "}
            <Link href="/admin/settings" className="underline text-foreground hover:text-primary">
              Admin → Settings
            </Link>{" "}
            and add the cluster SSH private key.
          </li>
          <li>
            Copy the public key shown there and make sure it is authorized on every node you plan
            to onboard — see the hints on the Settings page for different ways to do this (manual,
            AWS User Data, cloud-init, etc.).
          </li>
          <li>Return here to continue onboarding.</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">Phase 2 — Cluster Configuration</p>
        <p className="text-xs text-muted-foreground mt-1">Agent is connected. Complete each step to finish cluster setup.</p>
      </div>

      {stepTitles.map((title, idx) => {
        const state = stepStates[idx];
        const isActive = idx === currentStep;
        const isLocked = idx > currentStep && (idx === 0 || stepStates[idx - 1]?.status !== "done");

        return (
          <Card key={idx} className={isLocked ? "opacity-50" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  state.status === "done" ? "bg-green-100 text-green-700" :
                  state.status === "error" ? "bg-red-100 text-red-700" :
                  state.status === "running" ? "bg-blue-100 text-blue-700" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {state.status === "done" ? <Check className="h-4 w-4" /> :
                   state.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> :
                   idx + 1}
                </div>
                <CardTitle className="text-base">{title}</CardTitle>
                {state.status === "done" && <Badge className="ml-auto bg-green-100 text-green-700">Done</Badge>}
                {state.status === "error" && <Badge className="ml-auto" variant="destructive">Failed</Badge>}
              </div>
            </CardHeader>

            {isActive && (
              <CardContent className="space-y-4 pt-0">
                {/* NFS Form */}
                {idx === 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Mgmt NFS Server", key: "mgmtNfsServer", placeholder: "192.168.1.100" },
                      { label: "Mgmt NFS Path", key: "mgmtNfsPath", placeholder: "/mgmt" },
                      { label: "Data NFS Server", key: "dataNfsServer", placeholder: "192.168.1.100" },
                      { label: "Data NFS Path", key: "dataNfsPath", placeholder: "/aura-usrdata" },
                      { label: "Allowed Network", key: "nfsAllowedNetwork", placeholder: "192.168.1.0/24" },
                    ].map(({ label, key, placeholder }) => (
                      <div key={key} className="space-y-1">
                        <Label className="text-xs">{label}</Label>
                        <Input
                          placeholder={placeholder}
                          value={(nfs as any)[key]}
                          onChange={(e) => setNfs((p) => ({ ...p, [key]: e.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Nodes Form */}
                {idx === 1 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="ctrl-worker"
                        checked={controllerIsWorker}
                        onCheckedChange={(v) => setControllerIsWorker(!!v)}
                      />
                      <Label htmlFor="ctrl-worker" className="text-sm">Controller node is also a compute node</Label>
                    </div>
                    <div className="space-y-2">
                      {nodes.map((node, ni) => (
                        <div key={ni} className="grid grid-cols-6 gap-2 items-end">
                          <div className="col-span-2 space-y-1">
                            {ni === 0 && <Label className="text-xs">Hostname</Label>}
                            <Input placeholder="node-01" value={node.hostname} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, hostname: e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">IP</Label>}
                            <Input placeholder="10.0.0.2" value={node.ip} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, ip: e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">CPUs</Label>}
                            <Input type="number" value={node.cpus} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, cpus: +e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">Mem (MB)</Label>}
                            <Input type="number" value={node.memoryMb} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, memoryMb: +e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">GPUs</Label>}
                            <div className="flex gap-1">
                              <Input type="number" value={node.gpus} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, gpus: +e.target.value } : n))} />
                              {nodes.length > 1 && (
                                <Button variant="ghost" size="icon" onClick={() => setNodes((p) => p.filter((_, i) => i !== ni))}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setNodes((p) => [...p, { hostname: "", ip: "", cpus: 8, memoryMb: 16384, gpus: 0 }])}>
                      <Plus className="mr-1 h-4 w-4" /> Add Node
                    </Button>
                  </div>
                )}

                {/* Partitions Form */}
                {idx === 2 && (
                  <div className="space-y-2">
                    {partitions.map((p, pi) => (
                      <div key={pi} className="grid grid-cols-5 gap-2 items-end">
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs">Name</Label>}
                          <Input placeholder="compute" value={p.name} onChange={(e) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, name: e.target.value } : x))} />
                        </div>
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs">Nodes</Label>}
                          <Input placeholder="node-[01-10]" value={p.nodes} onChange={(e) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, nodes: e.target.value } : x))} />
                        </div>
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs">Max Time</Label>}
                          <Input placeholder="24:00:00" value={p.maxTime} onChange={(e) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, maxTime: e.target.value } : x))} />
                        </div>
                        <div className="space-y-1 flex flex-col">
                          {pi === 0 && <Label className="text-xs">Default</Label>}
                          <div className="flex items-center h-9">
                            <Checkbox checked={p.isDefault} onCheckedChange={(v) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, isDefault: !!v } : x))} />
                          </div>
                        </div>
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs invisible">Del</Label>}
                          {partitions.length > 1 && (
                            <Button variant="ghost" size="icon" onClick={() => setPartitions((prev) => prev.filter((_, i) => i !== pi))}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => setPartitions((p) => [...p, { name: "", nodes: "", maxTime: "24:00:00", isDefault: false }])}>
                      <Plus className="mr-1 h-4 w-4" /> Add Partition
                    </Button>
                  </div>
                )}

                {/* Health check step */}
                {idx === 3 && (
                  <p className="text-sm text-muted-foreground">
                    Runs <code>sinfo</code> via the agent to verify Slurm is healthy. On success the cluster becomes <strong>ACTIVE</strong>.
                  </p>
                )}

                {state.logs.length > 0 && <LogView lines={state.logs} status={state.status} />}

                {state.status !== "running" && (
                  <Button
                    onClick={idx === 0 ? runNfs : idx === 1 ? runNodes : idx === 2 ? runPartitions : runHealth}
                  >
                    {state.status === "error" ? "Retry" : idx === 3 ? "Run Health Check" : "Apply"}
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                )}
                {state.status === "running" && (
                  <Button disabled>
                    <Loader2 className="ml-1 h-4 w-4 animate-spin" /> Running...
                  </Button>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
