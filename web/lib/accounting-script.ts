// Shared script builders for Slurm accounting. Used by:
//   /api/clusters/[id]/accounting/apply  (user-triggered)
//   /api/clusters/[id]/bootstrap         (auto-enable at bootstrap end)
//
// The enable script installs MariaDB + slurmdbd, writes slurmdbd.conf, wires
// slurm.conf to use accounting_storage/slurmdbd, and registers the cluster +
// any provided users. Safe to re-run (idempotent-ish — ALTER USER resets the
// password each time so auth drift is self-healing).

export function buildEnableSlurmdbdScript(args: {
  dbPass: string;
  clusterSlurmName: string;
  usernames: string[];
}): string {
  const { dbPass, clusterSlurmName, usernames } = args;
  const userRegs = usernames.map((u) => `
$S sacctmgr -i add account ${u} Description="Aura user ${u}" Organization=Aura Cluster=${clusterSlurmName} 2>&1 | tail -5 || true
$S sacctmgr -i add user ${u} Account=${u} DefaultAccount=${u} 2>&1 | tail -5 || true
`).join("\n");

  return `#!/bin/bash
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Enabling Slurm accounting (slurmdbd + MariaDB)"
echo "============================================"

CONF=/etc/slurm/slurm.conf
if [ ! -f "$CONF" ]; then
  echo "[error] $CONF not found — run Bootstrap first"
  exit 1
fi

echo "[aura] Installing MariaDB + slurmdbd..."
export DEBIAN_FRONTEND=noninteractive
$S apt-get update -qq 2>&1 | tail -3
$S apt-get install -y -qq mariadb-server slurmdbd 2>&1 | tail -3

echo "[aura] Starting MariaDB..."
$S systemctl enable --now mariadb 2>&1 | tail -3
sleep 2

DBPASS='${dbPass}'
echo "[aura] Creating slurm_acct_db + user (password reset each run)..."
$S mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS slurm_acct_db;
CREATE USER IF NOT EXISTS 'slurm'@'localhost' IDENTIFIED BY '$DBPASS';
ALTER USER 'slurm'@'localhost' IDENTIFIED BY '$DBPASS';
GRANT ALL ON slurm_acct_db.* TO 'slurm'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "[aura] Writing slurmdbd.conf..."
$S bash -c "cat > /etc/slurm/slurmdbd.conf" <<SLURMDBD_EOF
AuthType=auth/munge
DbdHost=localhost
DbdPort=6819
SlurmUser=slurm
DebugLevel=info
LogFile=/var/log/slurm/slurmdbd.log
PidFile=/run/slurmdbd.pid
StorageType=accounting_storage/mysql
StorageHost=localhost
StoragePort=3306
StorageUser=slurm
StoragePass=$DBPASS
StorageLoc=slurm_acct_db
SLURMDBD_EOF
$S chown slurm:slurm /etc/slurm/slurmdbd.conf
$S chmod 600 /etc/slurm/slurmdbd.conf

echo "[aura] Starting slurmdbd..."
$S systemctl restart slurmdbd 2>&1 | tail -3 || true
$S systemctl enable slurmdbd 2>&1 | tail -3 || true
sleep 5

echo "[aura] Verifying slurmdbd is actually listening on 6819..."
for i in $(seq 1 10); do
  if $S ss -ltn 2>/dev/null | grep -q ':6819 ' || $S netstat -ltn 2>/dev/null | grep -q ':6819 '; then
    echo "  slurmdbd listening on 6819"
    break
  fi
  if [ $i -eq 10 ]; then
    echo "[error] slurmdbd is not listening on 6819 after 10s. Last 30 log lines:"
    $S journalctl -u slurmdbd -n 30 --no-pager 2>&1 | sed 's/^/    /' || \
      $S tail -30 /var/log/slurm/slurmdbd.log 2>&1 | sed 's/^/    /' || true
    exit 1
  fi
  sleep 1
done

echo "[aura] Patching slurm.conf to use slurmdbd..."
$S sed -i '/^AccountingStorageType=/d;/^AccountingStorageEnforce=/d;/^AccountingStorageHost=/d' "$CONF"
$S bash -c "cat >> $CONF" <<SLURM_ACCT_EOF
AccountingStorageType=accounting_storage/slurmdbd
AccountingStorageHost=localhost
AccountingStorageEnforce=associations
SLURM_ACCT_EOF

echo "[aura] Restarting slurmctld..."
$S systemctl restart slurmctld 2>&1 | tail -5
sleep 3

echo "[aura] Registering cluster '${clusterSlurmName}' in sacctmgr..."
$S sacctmgr -i add cluster ${clusterSlurmName} 2>&1 | tail -5 || true

echo "[aura] Registering ${usernames.length} user(s)..."
${userRegs}

echo ""
echo "[aura] Registered users:"
$S sacctmgr -s list user 2>&1 | head -40

echo ""
echo "[aura] Done. slurmdbd running, accounts created."
`;
}
