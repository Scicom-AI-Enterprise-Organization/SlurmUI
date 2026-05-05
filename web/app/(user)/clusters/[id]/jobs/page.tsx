/**
 * Thin re-export — the actual page is the Client Component in
 * `jobs-list-client.tsx`. Keeping this file as a server boundary lets
 * Next route to it without us having to mark the client file as the
 * page entrypoint.
 *
 * An earlier version pre-fetched the default jobs payload here and
 * passed it as `initialData`. That was wasted work — the client always
 * re-fetched on mount, so we paid for two parallel Prisma stacks per
 * request and pulled the query engine into the RSC render path. Under
 * a tight k8s memory limit the duplicated allocation tipped the heap
 * over and OOM-killed the pod. Removed.
 */
export { default } from "./jobs-list-client";
