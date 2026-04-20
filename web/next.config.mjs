/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // Required so `instrumentation.ts` runs on boot. Needed for the gitops
    // jobs reconciler to auto-tick under `next dev` — the custom server.ts
    // only runs in production.
    instrumentationHook: true,
  },
};

export default nextConfig;
