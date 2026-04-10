import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusConfig = {
  PROVISIONING: { label: "Provisioning", className: "bg-yellow-100 text-yellow-800" },
  ACTIVE: { label: "Active", className: "bg-green-100 text-green-800" },
  DEGRADED: { label: "Degraded", className: "bg-orange-100 text-orange-800" },
  OFFLINE: { label: "Offline", className: "bg-red-100 text-red-800" },
} as const;

interface ClusterStatusBadgeProps {
  status: keyof typeof statusConfig;
}

export function ClusterStatusBadge({ status }: ClusterStatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={cn("font-medium", config.className)}>
      {config.label}
    </Badge>
  );
}
