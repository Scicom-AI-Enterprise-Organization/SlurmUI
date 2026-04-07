import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { JobStatusBadge } from "./job-status-badge";

interface Job {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  partition: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  createdAt: string;
  cluster?: { name: string };
}

interface JobTableProps {
  jobs: Job[];
  showCluster?: boolean;
}

export function JobTable({ jobs, showCluster = false }: JobTableProps) {
  if (jobs.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground">No jobs found</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Job ID</TableHead>
          <TableHead>Slurm ID</TableHead>
          {showCluster && <TableHead>Cluster</TableHead>}
          <TableHead>Partition</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell>
              <Link
                href={`/clusters/${job.clusterId}/jobs/${job.id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {job.id.slice(0, 8)}...
              </Link>
            </TableCell>
            <TableCell>{job.slurmJobId ?? "-"}</TableCell>
            {showCluster && (
              <TableCell>{job.cluster?.name ?? job.clusterId.slice(0, 8)}</TableCell>
            )}
            <TableCell>{job.partition}</TableCell>
            <TableCell>
              <JobStatusBadge status={job.status} />
            </TableCell>
            <TableCell>
              {new Date(job.createdAt).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
