import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "default" | "muted" | "positive" | "warning" | "negative";

const TONE: Record<Tone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  positive: "text-chart-2",
  warning: "text-amber-600 dark:text-amber-400",
  negative: "text-destructive",
};

export function StatCard({
  label, value, sub, tone = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 space-y-0.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("text-2xl font-bold tabular-nums", TONE[tone])}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
