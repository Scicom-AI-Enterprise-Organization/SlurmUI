import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClusterStatusBadge } from "./cluster-status-badge";
import { Server, Clock, Hash } from "lucide-react";

interface ClusterCardProps {
  id: string;
  name: string;
  controllerHost: string;
  status: "PROVISIONING" | "ACTIVE" | "DEGRADED" | "OFFLINE";
  jobCount: number;
  createdAt: string;
}

export function ClusterCard({
  id,
  name,
  controllerHost,
  status,
  jobCount,
  createdAt,
}: ClusterCardProps) {
  return (
    <Link href={`/admin/clusters/${id}`}>
      <Card className="transition-shadow hover:shadow-md">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-lg font-semibold">{name}</CardTitle>
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
