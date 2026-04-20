// Node-runtime-only side of the instrumentation hook. Split out so the
// Edge-runtime bundle webpack builds for instrumentation.ts never traces
// into Node built-ins (child_process, fs, etc).

import { startGitopsJobsMonitor } from "./lib/gitops-jobs";

startGitopsJobsMonitor();
