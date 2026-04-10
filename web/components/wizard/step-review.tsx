"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface StepReviewProps {
  config: Record<string, unknown>;
}

export function StepReview({ config }: StepReviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">
          Review the cluster configuration JSON below. This will be passed to the
          bootstrap playbook.
        </p>
        <ScrollArea className="h-96 rounded-md border">
          <pre className="p-4 text-sm">
            {JSON.stringify(config, null, 2)}
          </pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
