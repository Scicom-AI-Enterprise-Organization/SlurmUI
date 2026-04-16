import { Card, CardContent } from "@/components/ui/card";
import { Rocket } from "lucide-react";

export function RequiresBootstrap() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 space-y-4">
        <Rocket className="h-10 w-10 text-muted-foreground/40" />
        <div className="text-center space-y-1">
          <p className="font-medium">Cluster not bootstrapped</p>
          <p className="text-sm text-muted-foreground">
            Click the Bootstrap button above to set up the controller first.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
