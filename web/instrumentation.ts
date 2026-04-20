// Next.js instrumentation hook. Runs once per server process — before the
// first request — under both `next dev` and `next start`. The custom
// server.ts entry path doesn't run in dev, so this is where we boot any
// always-on workers (gitops jobs reconciler, etc.) so they behave the same
// in dev and prod.
//
// Enabled via `experimental.instrumentationHook: true` in next.config.mjs.
// The real work lives in ./instrumentation-node.ts — keeping the dynamic
// import gated on NEXT_RUNTIME stops webpack from trying to bundle Node
// built-ins (child_process, fs) for the Edge runtime.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
