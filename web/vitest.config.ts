import { defineConfig } from "vitest/config";
import path from "node:path";

// Vitest config — kept intentionally minimal. The only suite right now
// is the end-to-end multipass cluster regression test, which orchestrates
// against a real running web server + real multipass VMs, so:
//   - timeouts are generous (bootstrap can take 5+ min on slow networks),
//   - tests run sequentially (the suite mutates real cluster state),
//   - we point "@" to the source dir so the suite can import from lib/.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    // Each `it()` block gets up to 15 minutes — bootstrap/python-package
    // installs over real SSH frequently push past Vitest's default 5s.
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
    // Single fork: the suite mutates a shared external cluster, so parallel
    // execution would cross-talk.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Vitest by default runs files in parallel; we only have one E2E suite
    // today but keep this strict so future additions don't regress.
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["verbose"],
    include: ["tests/**/*.test.ts"],
  },
});
