/**
 * Probe the controller's slurmdbd accounting DB for the maximum historical
 * JobId across every cluster it knows about, and return that + 1.
 *
 * Used at bootstrap time to seed `FirstJobId` in slurm.conf so that a
 * fresh slurmctld (state-dir wiped on teardown) on a shared backing
 * controller doesn't restart its JobId counter at 1 — which would
 * silently collide with historical JobIds still in slurmdbd's mariadb
 * data dir (the teardown intentionally doesn't drop the accounting DB).
 *
 * Returns 1 when:
 *   - mariadb isn't installed / running on the controller,
 *   - the `slurm_acct_db` schema doesn't exist yet,
 *   - no `<cluster>_job_table` table exists (fresh slurmdbd),
 *   - the SSH probe times out or otherwise can't get an answer.
 *
 * That default is safe — 1 is the same value slurm.conf would have
 * gotten without this probe.
 */
import { sshExecScript, type SshTarget } from "@/lib/ssh-exec";

export async function probeSlurmFirstJobId(target: SshTarget): Promise<number> {
  // The probe runs as root (sudo wrapper inside) and asks mysql directly
  // — much faster than firing up sacctmgr. `mysql` socket auth is what
  // the slurmdbd_storage role uses, so root on the controller already
  // has the right credentials.
  //
  // The inner loop iterates `<cluster>_job_table` tables one at a time
  // because GREATEST across UNIONs adds complexity without speeding
  // anything up — a one-row MAX scan on each table is sub-millisecond.
  const probe = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"

# Hard-fail fast if mariadb / mysql isn't reachable. Defaults to 1.
if ! command -v mysql >/dev/null 2>&1; then
  echo "FIRST_JOB_ID=1"
  exit 0
fi
if ! \$S mysql -e 'SELECT 1' slurm_acct_db >/dev/null 2>&1; then
  echo "FIRST_JOB_ID=1"
  exit 0
fi

# Find every per-cluster job_table (slurmdbd creates one per cluster
# the controller has ever been registered as) and take the global max.
TABLES=\$(\$S mysql -N -e "SELECT table_name FROM information_schema.tables \\
  WHERE table_schema='slurm_acct_db' AND table_name LIKE '%_job_table'" 2>/dev/null)
if [ -z "\$TABLES" ]; then
  echo "FIRST_JOB_ID=1"
  exit 0
fi

MAX=0
for T in \$TABLES; do
  V=\$(\$S mysql -N -e "SELECT IFNULL(MAX(id_job), 0) FROM slurm_acct_db.\$T" 2>/dev/null)
  if [ -n "\$V" ] && [ "\$V" -gt "\$MAX" ] 2>/dev/null; then
    MAX=\$V
  fi
done
echo "FIRST_JOB_ID=\$((MAX + 1))"
`;
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, probe, {
      // Tight timeout — the probe is a couple of fast mysql roundtrips.
      // If the cluster is unreachable we'd rather give up than block the
      // whole bootstrap on a network blip.
      timeoutMs: 15 * 1000,
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });
  const blob = chunks.join("\n");
  const m = blob.match(/FIRST_JOB_ID=(\d+)/);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
