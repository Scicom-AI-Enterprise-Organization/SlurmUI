/**
 * Listing-row shape transform — input is a Prisma row from the
 * /api/clusters/[id]/jobs endpoint, output is what the table renders.
 *
 * Pulling this out into its own module locks down the perf contract:
 * the route handler MUST drop `script` (which we only fetched to
 * extract the SBATCH job-name) and MUST never include `output` (cached
 * job stdout — can be megabytes per row). The unit test asserts the
 * output shape doesn't accidentally regrow.
 *
 * Kept in lib/ rather than inline in the route so the test doesn't
 * need to import `next/server`.
 */

const JOB_NAME_RE = /#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/;

/** Minimal subset of the Prisma `Job` shape we read from. Decoupled from
 * the generated client so tests don't import @prisma/client. */
export interface JobListInputRow {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  userId: string;
  partition: string;
  status: string;
  exitCode: number | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  sourceName: string | null;
  /** Stored job name (set on submit). When null we fall back to
   * extracting from `script` so legacy rows without this column keep
   * rendering correctly. */
  name?: string | null;
  /** Used to extract the SBATCH job-name when `name` is null. Dropped
   * from the output. */
  script: string;
  /** Sentinel: if the upstream ever leaks `output` here, the test will
   * catch it because the listing item type below has no such field. */
  [extra: string]: unknown;
}

export interface JobListItem {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  userId: string;
  partition: string;
  status: string;
  exitCode: number | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  sourceName: string | null;
  /** Extracted server-side from the `--job-name=` SBATCH directive. */
  name: string | null;
}

/** Extract `--job-name=foo` (or `-J foo`) from an SBATCH script body.
 * Returns null when no directive matches. */
export function extractJobName(script: string | null | undefined): string | null {
  if (!script) return null;
  const m = script.match(JOB_NAME_RE);
  return m ? m[1] : null;
}

/** Apply the listing transform to one row: drop `script`/`output`, add
 * derived `name`. Kept side-effect-free so the route handler can map
 * over its query result without copying boilerplate. */
export function toJobListItem(row: JobListInputRow): JobListItem {
  const {
    script: _script,
    // Defensive guard: even if a future contributor adds `output: true`
    // to the Prisma `select`, the destructure here drops it before the
    // payload is serialised to the browser.
    output: _output,
    ...rest
  } = row;
  return {
    id: rest.id,
    slurmJobId: rest.slurmJobId,
    clusterId: rest.clusterId,
    userId: rest.userId,
    partition: rest.partition,
    status: rest.status,
    exitCode: rest.exitCode,
    createdAt: rest.createdAt,
    updatedAt: rest.updatedAt,
    sourceName: rest.sourceName,
    // Prefer the stored name (set on submit, validated, unique among
    // running jobs); fall back to the script regex for legacy rows
    // backfilled before the column existed.
    name: (rest.name as string | null | undefined) ?? extractJobName(_script),
  };
}

/** Apply `toJobListItem` to an array. */
export function toJobListItems(rows: JobListInputRow[]): JobListItem[] {
  return rows.map(toJobListItem);
}
