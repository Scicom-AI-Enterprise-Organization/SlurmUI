import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClusterStatusBadge } from "./cluster-status-badge";
import { Server, Clock, Hash, Zap } from "lucide-react";

interface ClusterCardProps {
  id: string;
  name: string;
  controllerHost: string;
  status: "PROVISIONING" | "ACTIVE" | "DEGRADED" | "OFFLINE";
  jobCount: number;
  createdAt: string;
  // RunPod instant cluster — shows a yellow lightning bolt before the name.
  instant?: boolean;
}

export function ClusterCard({
  id,
  name,
  controllerHost,
  status,
  jobCount,
  createdAt,
  instant = false,
}: ClusterCardProps) {
  return (
    <Link href={`/admin/clusters/${id}`}>
      <Card className="cursor-pointer transition-colors hover:border-primary/60 hover:shadow-md">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-1.5 text-lg font-semibold">
            {instant && (
              <Zap
                className="h-4 w-4 shrink-0 fill-yellow-400 text-yellow-500"
                aria-label="Instant cluster"
              />
            )}
            {name}
          </CardTitle>
          <ClusterStatusBadge status={status} />
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              <span>{controllerHost}</span>
            </div>
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4" />
              <span>{jobCount} jobs</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span>Created {new Date(createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
