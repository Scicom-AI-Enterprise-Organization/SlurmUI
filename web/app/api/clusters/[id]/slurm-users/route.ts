import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { runSacctmgrOnCluster } from "@/lib/sacctmgr";

interface RouteParams { params: Promise<{ id: string }> }

interface SlurmUserRow {
  user: string;
  uid: number | null;
  gid: number | null;
  home: string | null;
  shell: string | null;
  linuxPresent: boolean;
  slurmPresent: boolean;
  defaultAccount: string;
  defaultQos: string;
  admin: string;
}

// GET /api/clusters/[id]/slurm-users — ground truth from the controller:
// merges `getent passwd` (Linux accounts with uid >= 1000) with
// `sacctmgr -P -n show user` (Slurm accounting presence). Replaces the
// DB-backed ClusterUser view so drift between Aura and reality is visible.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { ok, output } = await runSacctmgrOnCluster(
      id,
      `
echo "__PASSWD_START__"
getent passwd | awk -F: '$3 >= 1000 && $1 != "nobody" { print $0 }'
echo "__PASSWD_END__"
echo "__SACCTMGR_START__"
sacctmgr -P -n show user format=User,DefaultAccount,DefaultQOS,Admin 2>&1 || true
echo "__SACCTMGR_END__"
`,
    );
    if (!ok) return NextResponse.json({ error: output || "Failed" }, { status: 400 });

    const passwdBlock = between(output, "__PASSWD_START__", "__PASSWD_END__");
    const sacctBlock = between(output, "__SACCTMGR_START__", "__SACCTMGR_END__");

    // Normalize: strip CR (remote shells hand us CRLF) and surrounding
    // whitespace from every field so `"alice\r"` and `"alice"` collapse into
    // the same map key.
    const clean = (s: string | undefined) => (s ?? "").replace(/\r/g, "").trim();

    // Dedupe by *uid*, not name — SSSD/LDAP often serves the same account
    // under multiple names ("admin" vs "admin@domain"), producing two
    // `getent passwd` rows for one real user. Keep the shortest name as the
    // canonical display (so we show `admin` not `admin@corp.example.com`).
    const linuxByUid = new Map<number, { name: string; uid: number; gid: number; home: string; shell: string }>();
    for (const rawLine of passwdBlock.split("\n")) {
      const line = rawLine.replace(/\r/g, "");
      const parts = line.split(":");
      if (parts.length < 7) continue;
      const name = clean(parts[0]);
      if (!name) continue;
      const uid = parseInt(clean(parts[2]), 10);
      if (!Number.isFinite(uid)) continue;
      const gid = parseInt(clean(parts[3]), 10) || 0;
      const home = clean(parts[5]);
      const shell = clean(parts[6]);
      const prev = linuxByUid.get(uid);
      if (prev && prev.name.length <= name.length) continue;
      linuxByUid.set(uid, { name, uid, gid, home, shell });
    }
    const linuxByUser = new Map<string, { uid: number; gid: number; home: string; shell: string }>();
    for (const { name, ...rest } of linuxByUid.values()) {
      linuxByUser.set(name, rest);
    }

    // Detect slurmdbd-not-configured so we can tell the UI to hide the column
    // entirely instead of letting error text become fake user rows.
    const slurmAccountingDown =
      /Only 'accounting_storage\/slurmdbd' is supported|not running a supported accounting_storage plugin|Unable to contact slurm controller|slurm_persist_conn_open/i
        .test(sacctBlock);

    const slurmByUser = new Map<string, { defaultAccount: string; defaultQos: string; admin: string }>();
    if (!slurmAccountingDown) {
      for (const rawLine of sacctBlock.split("\n")) {
        const line = rawLine.replace(/\r/g, "").trim();
        if (!line) continue;
        // sacctmgr -P outputs exactly 4 pipe-delimited fields. Error/warning
        // lines printed to stdout (via 2>&1) have 0 pipes — reject anything
        // that doesn't match the expected shape so messages like
        // "Only 'accounting_storage/slurmdbd' is supported." don't get
        // mistaken for a username.
        if ((line.match(/\|/g) ?? []).length < 3) continue;
        const [user, defaultAccount, defaultQos, admin] = line.split("|").map(clean);
        if (!user) continue;
        // Reject lines whose "user" field contains whitespace, quotes, or
        // sentence punctuation — sacctmgr usernames never do.
        if (/[\s'"().]/.test(user)) continue;
        // Skip the occasional header row some sacctmgr builds emit even with -n.
        if (user.toLowerCase() === "user") continue;
        if (slurmByUser.has(user)) continue;
        slurmByUser.set(user, {
          defaultAccount: defaultAccount ?? "",
          defaultQos: defaultQos ?? "",
          admin: admin ?? "",
        });
      }
    }

    const users = new Set<string>();
    for (const k of linuxByUser.keys()) users.add(k);
    for (const k of slurmByUser.keys()) users.add(k);

    const rows: SlurmUserRow[] = [...users].sort().map((u) => {
      const lx = linuxByUser.get(u);
      const sl = slurmByUser.get(u);
      return {
        user: u,
        uid: lx?.uid ?? null,
        gid: lx?.gid ?? null,
        home: lx?.home ?? null,
        shell: lx?.shell ?? null,
        linuxPresent: !!lx,
        slurmPresent: !!sl,
        defaultAccount: sl?.defaultAccount ?? "",
        defaultQos: sl?.defaultQos ?? "",
        admin: sl?.admin ?? "",
      };
    });

    return NextResponse.json({
      users: rows,
      accountingDown: slurmAccountingDown,
      warning: slurmAccountingDown
        ? "slurmdbd accounting is not configured on this cluster — Slurm presence columns are unavailable."
        : undefined,
    });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

function between(blob: string, start: string, end: string): string {
  const s = blob.indexOf(start);
  const e = blob.indexOf(end);
  if (s === -1 || e === -1) return "";
  return blob.slice(s + start.length, e).trim();
}
