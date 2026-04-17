import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JobTable } from "@/components/jobs/job-table";
import { JobsLast24hChart } from "@/components/dashboard/jobs-last-24h-chart";
import { JobsStatusDonut } from "@/components/dashboard/jobs-status-donut";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const userId = session.user.id;
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [recentJobs, last24hJobs] = await Promise.all([
    prisma.job.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { cluster: { select: { name: true } } },
    }),
    prisma.job.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { status: true, createdAt: true },
    }),
  ]);

  // 24 one-hour buckets ending at `now`. Bucket N covers jobs created in
  // [now - (24-N)h, now - (23-N)h).
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const start = new Date(now.getTime() - (24 - i) * 60 * 60 * 1000);
    return {
      hour: `${String(start.getHours()).padStart(2, "0")}:00`,
      running: 0,
      completed: 0,
      failed: 0,
    };
  });

  for (const j of last24hJobs) {
    const diffHours = Math.floor((now.getTime() - j.createdAt.getTime()) / 3600_000);
    const idx = 23 - diffHours;
    if (idx < 0 || idx > 23) continue;
    const b = buckets[idx];
    if (j.status === "RUNNING" || j.status === "PENDING") b.running += 1;
    else if (j.status === "COMPLETED") b.completed += 1;
    else if (j.status === "FAILED" || j.status === "CANCELLED") b.failed += 1;
  }

  const last24Totals = buckets.reduce(
    (acc, b) => ({
      running: acc.running + b.running,
      completed: acc.completed + b.completed,
      failed: acc.failed + b.failed,
    }),
    { running: 0, completed: 0, failed: 0 }
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back, {session.user.name ?? session.user.email}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Last 24 hours</CardTitle>
          </CardHeader>
          <CardContent>
            <JobsLast24hChart data={buckets} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Status breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <JobsStatusDonut
              data={[
                { name: "Running", value: last24Totals.running, color: "var(--chart-2)" },
                { name: "Completed", value: last24Totals.completed, color: "var(--chart-3)" },
                { name: "Failed", value: last24Totals.failed, color: "var(--destructive)" },
              ]}
              total={last24Totals.running + last24Totals.completed + last24Totals.failed}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable
            jobs={recentJobs.map((j) => ({
              ...j,
              createdAt: j.createdAt.toISOString(),
            }))}
            showCluster
          />
        </CardContent>
      </Card>
    </div>
  );
}
