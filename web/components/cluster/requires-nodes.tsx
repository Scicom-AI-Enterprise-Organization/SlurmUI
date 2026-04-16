import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Server } from "lucide-react";

interface RequiresNodesProps {
  clusterId: string;
}

export function RequiresNodes({ clusterId }: RequiresNodesProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 space-y-4">
        <Server className="h-10 w-10 text-muted-foreground/40" />
        <div className="text-center space-y-1">
          <p className="font-medium">No nodes connected</p>
          <p className="text-sm text-muted-foreground">
            Add at least one node before configuring storage, users, or packages.
          </p>
        </div>
        <Link href={`/admin/clusters/${clusterId}/nodes`}>
          <Button variant="outline">Go to Nodes</Button>
        </Link>
      </CardContent>
    </Card>
  );
}
