import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JobTable } from "@/components/jobs/job-table";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function JobsPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const jobs = await prisma.job.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: { cluster: { select: { name: true } } },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Jobs</h1>
          <p className="text-muted-foreground">All your Slurm jobs across clusters</p>
        </div>
        <Link href="/clusters">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Submit Job
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Jobs ({jobs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable
            jobs={jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString() }))}
            showCluster
          />
        </CardContent>
      </Card>
    </div>
  );
}
