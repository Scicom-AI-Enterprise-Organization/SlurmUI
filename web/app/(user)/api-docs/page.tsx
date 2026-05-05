"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, KeyRound } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

function CodeBlock({ children }: { children: string }) {
  const copy = () => {
    navigator.clipboard?.writeText(children);
    toast.success("Copied");
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 pr-12 font-mono text-xs leading-relaxed">
        {children}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2"
        onClick={copy}
        title="Copy"
      >
        <Copy className="h-3 w-3" />
      </Button>
    </div>
  );
}

export default function ApiDocsPage() {
  const [host, setHost] = useState<string>("");

  useEffect(() => {
    // Use the page's own origin so examples drop in without editing.
    if (typeof window !== "undefined") setHost(window.location.origin);
  }, []);

  const base = host || "https://slurmui.example.com";

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API</h1>
          <p className="text-sm text-muted-foreground">
            Programmatic job submission &amp; inspection. All endpoints are rooted under <code>/api/v1</code>.
          </p>
        </div>
        <Button asChild>
          <Link href="/profile/api-tokens"><KeyRound className="mr-2 h-4 w-4" /> Manage tokens</Link>
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Authentication</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Send <code>Authorization: Bearer &lt;token&gt;</code> on every request. Tokens are minted
            at <Link href="/profile/api-tokens" className="underline">/profile/api-tokens</Link> and
            inherit your role — <code>ADMIN</code> can submit to any cluster and see any job;
            <code>VIEWER</code> is read-only and restricted to their own jobs.
          </p>
          <p>
            Sessions (browser cookie) are also accepted so the same endpoints can back your own UI
            integrations without extra plumbing.
          </p>
          <CodeBlock>{`# one-off smoke test
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  ${base}/api/v1/clusters/my-cluster/jobs`}</CodeBlock>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>List clusters — <code>GET /api/v1/clusters</code></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Handy for discovering what you can submit to. Returns id, name, mode,
            status, partitions, and the default partition for each cluster you're
            provisioned on (admins see all).
          </p>
          <CodeBlock>{`curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  ${base}/api/v1/clusters | jq`}</CodeBlock>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submit a job — <code>POST /api/v1/clusters/:cluster/jobs</code></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            <code>:cluster</code> accepts either the cluster's UUID or its name (whichever
            is handier for scripting). Body:
          </p>
          <CodeBlock>{`{
  "script":   "string, required — full #!/bin/bash SBATCH script",
  "partition": "string, optional — defaults to the cluster's default partition",
  "name":      "string, optional — prepends #SBATCH --job-name= if missing"
}`}</CodeBlock>
          <CodeBlock>{`curl -s -X POST "${base}/api/v1/clusters/my-cluster/jobs" \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @- <<'EOF'
{
  "name": "hello",
  "partition": "main",
  "script": "#!/bin/bash\\n#SBATCH --time=00:01:00\\nhostname\\ndate\\nsleep 5\\necho done"
}
EOF`}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            Returns <code>201</code> with <code>{`{ id, slurmJobId, clusterId, partition, status, createdAt }`}</code>.
            Use the <code>id</code> (DB uuid) for the detail endpoint below.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>List jobs — <code>GET /api/v1/clusters/:cluster/jobs</code></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Supports filters and pagination.</p>
          <CodeBlock>{`# all jobs you can see on this cluster, newest first
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/clusters/my-cluster/jobs?limit=20&page=1"

# only pending + running
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/clusters/my-cluster/jobs?status=RUNNING"

# date range + partition + name filter
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/clusters/my-cluster/jobs?partition=gpu&name=train&from=2026-04-01&to=2026-04-24"`}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            Query params: <code>page</code>, <code>limit</code> (≤100), <code>status</code>
            (<code>PENDING</code> / <code>RUNNING</code> / <code>COMPLETED</code> / <code>FAILED</code> /
            <code>CANCELLED</code>), <code>partition</code>, <code>name</code> (searches script body,
            case-insensitive), <code>from</code> / <code>to</code> (ISO dates, filter on
            <code>createdAt</code>).
          </p>
          <p className="text-xs text-muted-foreground">
            Returns <code>{`{ jobs: [...], pagination: { page, limit, total, pages } }`}</code>.
            Non-admins see only their own jobs.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Get one job — <code>GET /api/v1/jobs/:id</code></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            <code>:id</code> is the DB uuid returned by submit / list — not the Slurm job id.
            Append <code>?output=1</code> to also fetch the last 1 MB of the Slurm stdout
            file over SSH.
          </p>
          <CodeBlock>{`curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/jobs/$JOB_ID"

# with tail of stdout
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/jobs/$JOB_ID?output=1"`}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            Returns <code>{`{ job: {...} }`}</code> or <code>{`{ job, output, outputSize }`}</code> when
            <code>output=1</code>. <code>outputSize</code> is the full on-disk size in bytes;
            <code>output</code> is the tail truncated to ~1 MB.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resync job state — <code>POST /api/v1/jobs/:id/resync</code></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Re-queries Slurm (<code>squeue</code> then <code>sacct</code>) and overwrites the
            DB row's status + exit code. Useful when the background watcher misses a terminal
            transition (bastion SSH drop mid-tail, output file on an unmounted path, etc.).
          </p>
          <CodeBlock>{`curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/jobs/$JOB_ID/resync" | jq`}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            Returns <code>{`{ updated, previous, next, exitCode, source }`}</code> when Slurm
            knows the job, or <code>{`{ updated: false, error }`}</code> when accounting has no record
            of it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cancel a job — <code>POST /api/v1/jobs/:id/cancel</code></CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Runs <code>scancel --signal=KILL --full</code> on the controller (with a sudo
            fallback) and flips the DB row to <code>CANCELLED</code>. Safe to call on
            already-terminal jobs.
          </p>
          <CodeBlock>{`curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/jobs/$JOB_ID/cancel" | jq`}</CodeBlock>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Trim cached job logs — <code>POST /api/v1/admin/maintenance/truncate-job-output</code>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Admin-only. Shrinks every <code>Job.output</code> row down to the last 256 KB
            and runs <code>VACUUM (ANALYZE) &quot;Job&quot;</code> to reclaim TOAST disk
            space. Use it after a noisy job (vLLM debug logs, etc.) has bloated the column,
            or after upgrading from a build whose watcher didn&apos;t cap captured output.
            Idempotent — rows already at or under the cap are left alone.
          </p>
          <CodeBlock>{`curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "${base}/api/v1/admin/maintenance/truncate-job-output" | jq`}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            Returns <code>{`{ ok, capBytes, rowsTrimmed, vacuumed, before, after }`}</code>
            where <code>before</code> / <code>after</code> each report
            <code>{` { oversizedRows, totalBytes, largestRowBytes, avgRowBytes }`}</code>.
            Returns <code>403</code> for non-admin tokens.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Quick-start: poll until done</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <CodeBlock>{`AURA_TOKEN="aura_xxxxxxxxxxxxxxxxxxxxxxxxxx"
BASE="${base}/api/v1"

# submit
RES=$(curl -s -X POST "$BASE/clusters/my-cluster/jobs" \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"demo","script":"#!/bin/bash\\nhostname\\ndate"}')
JOB_ID=$(echo "$RES" | jq -r .id)
echo "submitted $JOB_ID"

# poll
while true; do
  STATUS=$(curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
    "$BASE/jobs/$JOB_ID" | jq -r .job.status)
  echo "status=$STATUS"
  [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "CANCELLED" ] && break
  sleep 5
done

# tail output
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "$BASE/jobs/$JOB_ID?output=1" | jq -r .output`}</CodeBlock>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Errors</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <ul className="list-disc space-y-1 pl-5">
            <li><code>401 Unauthorized</code> — missing / revoked / wrong token.</li>
            <li><code>403 Forbidden</code> — VIEWER trying to submit, or non-admin reading someone else's job.</li>
            <li><code>404 Not Found</code> — cluster name/id unknown, or job id doesn't exist.</li>
            <li><code>400 Bad Request</code> — missing <code>script</code>, or invalid JSON.</li>
            <li><code>502 Bad Gateway</code> — submit reached the cluster but <code>sbatch</code> errored (error text is in the body).</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
