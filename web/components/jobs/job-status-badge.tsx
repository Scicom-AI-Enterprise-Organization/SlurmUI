import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusConfig = {
  PENDING: { label: "Pending", className: "bg-yellow-100 text-yellow-800" },
  RUNNING: { label: "Running", className: "bg-blue-100 text-blue-800" },
  COMPLETED: { label: "Completed", className: "bg-green-100 text-green-800" },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-800" },
  CANCELLED: { label: "Cancelled", className: "bg-gray-100 text-gray-800" },
} as const;

interface JobStatusBadgeProps {
  status: keyof typeof statusConfig;
}

export function JobStatusBadge({ status }: JobStatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={cn("font-medium", config.className)}>
      {config.label}
    </Badge>
  );
}
