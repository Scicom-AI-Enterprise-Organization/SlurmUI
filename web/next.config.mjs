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
  // Disable Next's automatic trailing-slash redirect. The /job-proxy/*
  // route adds the slash itself when missing so upstream services that
  // compute base URLs from `window.location.pathname` (code-server,
  // JupyterLab) anchor relative imports correctly. Without this flag,
  // Next strips the slash and our redirect re-adds it → infinite loop.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
