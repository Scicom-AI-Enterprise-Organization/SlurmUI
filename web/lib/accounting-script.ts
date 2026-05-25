// Shared script builders for Slurm accounting. Used by:
//   /api/clusters/[id]/accounting/apply  (user-triggered)
//   /api/clusters/[id]/bootstrap         (auto-enable at bootstrap end)
//
// The enable script installs MariaDB + slurmdbd, writes slurmdbd.conf, wires
// slurm.conf to use accounting_storage/slurmdbd, and registers the cluster +
// any provided users. Safe to re-run (idempotent-ish — ALTER USER resets the
// password each time so auth drift is self-healing).

/**
 * Bash that restarts slurmctld via whichever supervisor the host runs
 * (systemd / pm2-go) and prints the resulting active state. Shared
 * between the disable + fifo paths below.
 */
function restartSlurmctldSnippet(): string {
  return `if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  $S systemctl restart slurmctld 2>&1 | tail -5 || true
  sleep 2
  $S systemctl is-active --quiet slurmctld && echo "[aura] slurmctld is active" || echo "[aura] slurmctld NOT active"
else
  # pm2-go's "start" is its restart primitive, but if the wrapper PID has
  # drifted from the child the start silently no-ops and the old binary
  # keeps running with the OLD slurm.conf. Force-stop + SIGKILL-by-binary
  # before start so the new config is actually loaded.
  $S /usr/local/bin/pm2 stop slurmctld 2>/dev/null || true
  $S pkill -9 -x slurmctld 2>/dev/null || true
  $S /usr/local/bin/pm2 start /etc/aura/pm2/slurmctld.json 2>&1 | tail -5 || true
  sleep 2
  if $S [ -f /root/.pm2-go/pids/slurmctld.pid ] && $S kill -0 "$(cat /root/.pm2-go/pids/slurmctld.pid)" 2>/dev/null; then
    echo "[aura] slurmctld is active"
  else
    echo "[aura] slurmctld NOT active"
  fi
fi`;
}

/** Strip accounting from slurm.conf and restart slurmctld so jobs flow
 *  through without account enforcement. */
export function buildDisableAccountingScript(): string {
  return `#!/bin/bash
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Disabling Slurm accounting"
echo "============================================"

CONF=/etc/slurm/slurm.conf
if [ ! -f "$CONF" ]; then
  echo "[error] $CONF not found — run Bootstrap first"
  exit 1
fi

echo "[aura] Current AccountingStorageType lines:"
$S grep -n '^AccountingStorage' "$CONF" || echo "  (none)"

$S sed -i '/^AccountingStorageType=/d;/^AccountingStorageEnforce=/d;/^AccountingStorageHost=/d;/^AccountingStoragePass=/d;/^AccountingStorageUser=/d;/^AccountingStoragePort=/d;/^AccountingStorageLoc=/d' "$CONF"
echo "AccountingStorageType=accounting_storage/none" | $S tee -a "$CONF" > /dev/null

echo ""
echo "[aura] After:"
$S grep -n '^AccountingStorage' "$CONF"

echo ""
echo "[aura] Restarting slurmctld..."
${restartSlurmctldSnippet()}

echo ""
echo "[aura] Done. Jobs submit without account enforcement."
`;
}

/** Swap PriorityType to FIFO ordering. */
export function buildFifoSchedulerScript(): string {
  return `#!/bin/bash
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Switching to FIFO priority scheduling"
echo "============================================"

CONF=/etc/slurm/slurm.conf
if [ ! -f "$CONF" ]; then
  echo "[error] $CONF not found — run Bootstrap first"
  exit 1
fi

echo "[aura] Current scheduler config:"
$S grep -nE '^PriorityType=|^SchedulerType=' "$CONF" || echo "  (defaults)"

$S sed -i '/^PriorityType=/d' "$CONF"
echo "PriorityType=priority/basic" | $S tee -a "$CONF" > /dev/null

echo ""
echo "[aura] After:"
$S grep -nE '^PriorityType=' "$CONF"

echo ""
echo "[aura] Restarting slurmctld..."
${restartSlurmctldSnippet()}

echo ""
echo "[aura] Done. Jobs are now ordered FIFO — no fair-share math."
`;
}

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
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  $S systemctl enable --now mariadb 2>&1 | tail -3
else
  # Container path (pm2-go): apt's postinst gets blocked by policy-rc.d
  # so neither the data dir nor the unix socket exist. Initialize both,
  # register with pm2-go, then wait for the socket to appear.
  $S mkdir -p /run/mysqld
  $S chown mysql:mysql /run/mysqld
  $S mkdir -p /var/lib/mysql /etc/aura/pm2 /var/log/aura
  if [ ! -f /var/lib/mysql/aria_log_control ]; then
    echo "  initialising /var/lib/mysql data dir..."
    $S mariadb-install-db --user=mysql --datadir=/var/lib/mysql 2>&1 | tail -3 || true
  fi
  $S bash -c 'cat > /etc/aura/pm2/mariadb.json' <<'MARIA_JSON'
[
  {
    "name": "mariadb",
    "executable_path": "/usr/sbin/mariadbd",
    "args": ["--user=mysql", "--datadir=/var/lib/mysql", "--socket=/run/mysqld/mysqld.sock", "--pid-file=/run/mysqld/mariadb.pid"],
    "cwd": "/",
    "autorestart": true
  }
]
MARIA_JSON
  # See restartSlurmctldSnippet — same pm2-go wrapper/child drift bug. On
  # first install there's nothing running so stop+pkill is a no-op; on
  # re-run they ensure the prior mariadbd is really gone before we relaunch.
  $S /usr/local/bin/pm2 stop mariadb 2>/dev/null || true
  $S pkill -9 -x mariadbd 2>/dev/null || true
  $S /usr/local/bin/pm2 start /etc/aura/pm2/mariadb.json 2>&1 | tail -3
  echo "  waiting for /run/mysqld/mysqld.sock..."
  for i in $(seq 1 30); do
    if $S [ -S /run/mysqld/mysqld.sock ]; then
      echo "    socket ready"; break
    fi
    if [ $i -eq 30 ]; then
      echo "[error] MariaDB socket never appeared. Last 30 pm2 log lines:"
      $S tail -30 /root/.pm2-go/logs/mariadb-err.log /root/.pm2-go/logs/mariadb-out.log 2>/dev/null | sed 's/^/    /' || true
      exit 1
    fi
    sleep 1
  done
fi
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
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  $S systemctl restart slurmdbd 2>&1 | tail -3 || true
  $S systemctl enable slurmdbd 2>&1 | tail -3 || true
else
  # Same pm2-go drift mitigation as slurmctld above.
  $S /usr/local/bin/pm2 stop slurmdbd 2>/dev/null || true
  $S pkill -9 -x slurmdbd 2>/dev/null || true
  $S /usr/local/bin/pm2 start /etc/aura/pm2/slurmdbd.json 2>&1 | tail -3 || true
fi
sleep 5

echo "[aura] Verifying slurmdbd is actually listening on 6819..."
for i in $(seq 1 10); do
  if $S ss -ltn 2>/dev/null | grep -q ':6819 ' || $S netstat -ltn 2>/dev/null | grep -q ':6819 '; then
    echo "  slurmdbd listening on 6819"
    break
  fi
  if [ $i -eq 10 ]; then
    echo "[error] slurmdbd is not listening on 6819 after 10s. Last 30 log lines:"
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
      $S journalctl -u slurmdbd -n 30 --no-pager 2>&1 | sed 's/^/    /' || \
        $S tail -30 /var/log/slurm/slurmdbd.log 2>&1 | sed 's/^/    /' || true
    else
      $S tail -n 30 /root/.pm2-go/logs/slurmdbd-out.log /root/.pm2-go/logs/slurmdbd-err.log 2>&1 | sed 's/^/    /' || true
    fi
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
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  $S systemctl restart slurmctld 2>&1 | tail -5
else
  # Same pm2-go drift mitigation as the snippet above.
  $S /usr/local/bin/pm2 stop slurmctld 2>/dev/null || true
  $S pkill -9 -x slurmctld 2>/dev/null || true
  $S /usr/local/bin/pm2 start /etc/aura/pm2/slurmctld.json 2>&1 | tail -5
fi
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
