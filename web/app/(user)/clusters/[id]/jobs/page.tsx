"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { JobTable } from "@/components/jobs/job-table";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import Link from "next/link";

interface Job {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  partition: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  createdAt: string;
}

export default function JobListPage() {
  const params = useParams();
  const clusterId = params.id as string;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/jobs`)
      .then((res) => res.json())
      .then((data) => setJobs(data.jobs ?? []))
      .catch(() => toast.error("Failed to load jobs"))
      .finally(() => setLoading(false));
  }, [clusterId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Jobs</h1>
          <p className="text-muted-foreground">Manage cluster jobs</p>
        </div>
        <Link href={`/clusters/${clusterId}/jobs/new`}>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Submit Job
          </Button>
        </Link>
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Loading...</p>
      ) : (
        <JobTable jobs={jobs} />
      )}
    </div>
  );
}
