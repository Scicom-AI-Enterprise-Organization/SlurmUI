"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScriptEditor } from "@/components/jobs/script-editor";
import { toast } from "sonner";
import { Send } from "lucide-react";

export default function NewJobPage() {
  const params = useParams();
  const router = useRouter();
  const clusterId = params.id as string;

  const [script, setScript] = useState("");
  const [partition, setPartition] = useState("");
  const [partitions, setPartitions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Fetch available partitions from cluster config
  useEffect(() => {
    fetch(`/api/clusters/${clusterId}`)
      .then((res) => res.json())
      .then((cluster) => {
        const config = cluster.config as Record<string, unknown>;
        const parts = (config.slurm_partitions ?? []) as Array<{ name: string; default?: boolean }>;
        setPartitions(parts.map((p) => p.name));
        const defaultPart = parts.find((p) => p.default);
        if (defaultPart) setPartition(defaultPart.name);
      })
      .catch(() => {
        toast.error("Failed to load cluster config");
      });
  }, [clusterId]);

  const handleSubmit = async () => {
    if (!script || !partition) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, partition }),
      });

      if (res.ok || res.status === 201) {
        const job = await res.json();
        toast.success(`Job submitted — ID: ${job.id}`);
        router.push(`/clusters/${clusterId}/jobs/${job.id}`);
      } else {
        const err = await res.json();
        toast.error(err.error ?? "Unknown error");
      }
    } catch {
      toast.error("Failed to submit job");
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

      <Card>
        <CardHeader>
          <CardTitle>Job Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Partition</Label>
            <Select value={partition} onValueChange={setPartition}>
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

          <ScriptEditor value={script} onChange={setScript} />

          <Button
            onClick={handleSubmit}
            disabled={submitting || !script || !partition}
            className="w-full"
          >
            <Send className="mr-2 h-4 w-4" />
            {submitting ? "Submitting..." : "Submit Job"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
