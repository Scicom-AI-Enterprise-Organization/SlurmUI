"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Check, Clock, Cpu, KeyRound, Loader2, Mail, RefreshCw, Trash2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface GpuProviderRecord {
  id: string;
  name: string;
  kind: string;
  apiKeyLast4: string;
  accountEmail: string | null;
  validatedAt: string | null;
  createdAt: string;
}

interface GpuTypeRow {
  id: string;
  displayName: string;
  memoryInGb: number | null;
  secureCloud: boolean;
  communityCloud: boolean;
  stockStatus: string | null;
  pricePerHr: number | null;
  spotPricePerHr: number | null;
}

interface TestState {
  ok: boolean;
  message: string;
}

const KIND_LABELS: Record<string, string> = { runpod: "RunPod" };

interface GpuProviderListProps {
  initialProviders: GpuProviderRecord[];
}

export function GpuProviderList({ initialProviders }: GpuProviderListProps) {
  const [providers, setProviders] = useState<GpuProviderRecord[]>(initialProviders);

  // Re-test
  const [retestingId, setRetestingId] = useState<string | null>(null);
  const [retestResults, setRetestResults] = useState<Record<string, TestState>>({});

  // GPU catalogue dialog
  const [gpuDialogFor, setGpuDialogFor] = useState<GpuProviderRecord | null>(null);
  const [gpuCache, setGpuCache] = useState<Record<string, GpuTypeRow[]>>({});
  const [gpusLoading, setGpusLoading] = useState(false);
  const [gpusError, setGpusError] = useState<string | null>(null);

  // Delete confirmation
  const [deleteFor, setDeleteFor] = useState<GpuProviderRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleRetest(provider: GpuProviderRecord) {
    setRetestingId(provider.id);
    setRetestResults((prev) => { const next = { ...prev }; delete next[provider.id]; return next; });
    try {
      const res = await fetch(`/api/admin/gpu-providers/${provider.id}/test`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRetestResults((prev) => ({ ...prev, [provider.id]: { ok: false, message: data.error } }));
        return;
      }
      setRetestResults((prev) => ({ ...prev, [provider.id]: data }));
      if (data.ok) {
        setProviders((prev) => prev.map((p) => p.id === provider.id
          ? { ...p, validatedAt: new Date().toISOString(), accountEmail: data.accountEmail ?? p.accountEmail }
          : p));
      }
    } catch {
      setRetestResults((prev) => ({ ...prev, [provider.id]: { ok: false, message: "Request failed" } }));
    } finally {
      setRetestingId(null);
    }
  }

  async function handleShowGpus(provider: GpuProviderRecord) {
    setGpuDialogFor(provider);
    setGpusError(null);
    if (gpuCache[provider.id]) return;
    setGpusLoading(true);
    try {
      const res = await fetch(`/api/admin/gpu-providers/${provider.id}/gpus`);
      const data = await res.json();
      if (!res.ok) { setGpusError(data.error); return; }
      // In-stock first, then alphabetical — matches how you'd scan the list.
      const sorted = (data as GpuTypeRow[]).sort((a, b) => {
        const stockDiff = Number(!!b.stockStatus) - Number(!!a.stockStatus);
        return stockDiff !== 0 ? stockDiff : a.displayName.localeCompare(b.displayName);
      });
      setGpuCache((prev) => ({ ...prev, [provider.id]: sorted }));
    } catch {
      setGpusError("Request failed");
    } finally {
      setGpusLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteFor) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/gpu-providers/${deleteFor.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        setDeleteError(data.error);
        return;
      }
      setProviders((prev) => prev.filter((p) => p.id !== deleteFor.id));
      setDeleteFor(null);
    } finally {
      setDeleting(false);
    }
  }

  const dialogGpus = gpuDialogFor ? gpuCache[gpuDialogFor.id] : undefined;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {providers.map((provider) => {
          const retest = retestResults[provider.id];
          return (
            <Card key={provider.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-lg font-semibold">{provider.name}</CardTitle>
                <Badge variant="secondary">{KIND_LABELS[provider.kind] ?? provider.kind}</Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    <span className="font-mono">****{provider.apiKeyLast4}</span>
                  </div>
                  {provider.accountEmail && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      <span className="truncate">{provider.accountEmail}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    <span>
                      {provider.validatedAt
                        ? `Validated ${new Date(provider.validatedAt).toLocaleString()}`
                        : "Never validated"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span>Created {new Date(provider.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1 border-t pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2"
                    onClick={() => handleRetest(provider)}
                    disabled={retestingId === provider.id}
                    title="Re-test connection"
                  >
                    {retestingId === provider.id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : retest
                        ? retest.ok
                          ? <Check className="h-4 w-4 text-green-600" />
                          : <X className="h-4 w-4 text-destructive" />
                        : <RefreshCw className="h-4 w-4" />}
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2"
                    onClick={() => handleShowGpus(provider)}
                    title="Show available GPUs"
                  >
                    <Cpu className="h-4 w-4" />
                    GPUs
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-8 w-8 text-destructive"
                    onClick={() => { setDeleteError(null); setDeleteFor(provider); }}
                    title="Delete provider"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {retest && (
                  <p className={cn("text-xs", retest.ok ? "text-green-600" : "text-destructive")}>
                    {retest.message}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* GPU catalogue */}
      <Dialog open={!!gpuDialogFor} onOpenChange={(o) => !o && setGpuDialogFor(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              {gpuDialogFor?.name} — available GPUs
            </DialogTitle>
          </DialogHeader>
          {gpusLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading GPU catalogue…
            </div>
          ) : gpusError && !dialogGpus ? (
            <p className="py-4 text-sm text-destructive">{gpusError}</p>
          ) : dialogGpus && dialogGpus.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No GPU types returned.</p>
          ) : dialogGpus ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>GPU</TableHead>
                  <TableHead>VRAM</TableHead>
                  <TableHead>Cloud</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead className="text-right">On-demand</TableHead>
                  <TableHead className="text-right">Spot</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dialogGpus.map((gpu) => (
                  <TableRow key={gpu.id} className={cn(!gpu.stockStatus && "opacity-50")}>
                    <TableCell className="font-medium">{gpu.displayName}</TableCell>
                    <TableCell>{gpu.memoryInGb != null ? `${gpu.memoryInGb} GB` : "—"}</TableCell>
                    <TableCell className="space-x-1">
                      {gpu.secureCloud && <Badge variant="outline" className="text-xs">Secure</Badge>}
                      {gpu.communityCloud && <Badge variant="outline" className="text-xs">Community</Badge>}
                    </TableCell>
                    <TableCell>
                      {gpu.stockStatus
                        ? <Badge variant="secondary" className="text-xs">{gpu.stockStatus}</Badge>
                        : <span className="text-xs text-muted-foreground">Out of stock</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {gpu.pricePerHr != null ? `$${gpu.pricePerHr.toFixed(2)}/hr` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {gpu.spotPricePerHr != null ? `$${gpu.spotPricePerHr.toFixed(2)}/hr` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteFor} onOpenChange={(o) => !o && !deleting && setDeleteFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Delete GPU provider?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              This removes <span className="font-medium">{deleteFor?.name}</span> and its stored
              API key from Aura. Nothing is changed on the provider side.
            </p>
            {deleteError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                {deleteError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
