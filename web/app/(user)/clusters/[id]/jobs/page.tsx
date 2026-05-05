/**
 * Thin wrapper around the Client Component in `jobs-list-client.tsx`.
 *
 * An earlier version pre-fetched the default jobs payload here and
 * passed it as `initialData`. That was wasted work — the client always
 * re-fetched on mount, so we paid for two parallel Prisma stacks per
 * request and pulled the query engine into the RSC render path. Under
 * a tight k8s memory limit the duplicated allocation tipped the heap
 * over and OOM-killed the pod. Removed.
 *
 * We can't `export { default } from "./jobs-list-client"` because
 * Next's page-export type check rejects a default whose props include
 * anything beyond `params`/`searchParams`. The client component still
 * declares an optional `initialData` prop, so we wrap it.
 */
import JobListPage from "./jobs-list-client";

export default function JobsListServerPage() {
  return <JobListPage />;
}
