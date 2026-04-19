import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, sshExecScript } from "@/lib/ssh-exec";
import { sendCommandAndWait } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/nodes — list nodes
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  // SSH mode: run sinfo via SSH on the controller
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) {
      return NextResponse.json({ error: "No SSH key" }, { status: 412 });
    }

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    try {
      // Use sshExecScript with a marker so we can extract output cleanly
      // (bastion shells include welcome banner + shell prompts in stdout)
      const MARKER = "__AURA_SINFO_" + Date.now() + "__";
      const script = `
echo "${MARKER}_START"
# Use the flat per-node format, NOT sinfo --json. The JSON variant groups
# nodes that share state/partition into a single entry (with cpus.total
# summed and memory.maximum as the group max), which we then pin onto every
# node individually — the "6 CPUs / 8 GB on all rows" bug.
sinfo -N --noheader --format='%N|%T|%c|%m|%G|%P|%v' 2>/dev/null || echo ''
echo "${MARKER}_END"
# Per-node Slurm version map (emitted OUTSIDE the main markers so the JSON
# parser upstream doesn't choke on these extra lines appended to sinfo's
# output). The node route picks this up via its own __VERSIONS markers.
echo "__VERSIONS_START__"
sinfo -N -h -o '%N|%v' 2>/dev/null | sort -u
echo "__VERSIONS_END__"
`;

      const rawChunks: string[] = [];
      await new Promise<void>((resolve) => {
        sshExecScript(target, script, {
          // Skip stderr — ssh welcome banners and warnings otherwise land in
          // the stream and break JSON.parse on sinfo --json output.
          onStream: (line) => {
            if (!line.startsWith("[stderr]")) rawChunks.push(line);
          },
          onComplete: () => resolve(),
        });
      });

      // Extract content between markers
      const full = rawChunks.join("\n");
      const startIdx = full.indexOf(`${MARKER}_START`);
      const endIdx = full.indexOf(`${MARKER}_END`);
      const extracted = startIdx !== -1 && endIdx !== -1
        ? full.slice(startIdx + `${MARKER}_START`.length, endIdx).trim()
        : "";

      // Per-node Slurm version map (sinfo -N -o '%N|%v' appended after the
      // main output). Build once, then merge into whichever parsing path runs.
      const versionByNode: Record<string, string> = {};
      const vStart = full.indexOf("__VERSIONS_START__");
      const vEnd = full.indexOf("__VERSIONS_END__");
      if (vStart !== -1 && vEnd !== -1) {
        for (const line of full.slice(vStart + 18, vEnd).split("\n")) {
          const [name, ver] = line.trim().split("|");
          if (name && ver) versionByNode[name] = ver;
        }
      }

      const result = {
        success: !!extracted,
        stdout: extracted,
        stderr: "",
        exitCode: extracted ? 0 : null,
      };

      // Fall back to DB if sinfo is unhappy (slurmctld down, package missing,
      // permission issue). Without this the UI shows "no nodes" and admins
      // can't even use Edit/Delete to recover. Detect both:
      //   - empty extracted output → command never produced anything, OR
      //   - any "Unable to contact slurm controller" message → daemon down.
      const looksDead =
        !extracted ||
        /Unable to contact slurm controller|connect failure|No such file or directory/i.test(extracted);
      if (looksDead) {
        const config = cluster.config as Record<string, unknown>;
        const entries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip?: string }>;
        const nodes = entries.map((e) => ({
          name: e.hostname,
          state: "unreachable",
          cpus: 0,
          memory: 0,
          partitions: [],
        }));
        return NextResponse.json({
          nodes,
          warning: "slurmctld unreachable — showing nodes from cluster config. State / CPUs / memory will be 0 until the controller is back.",
        });
      }

      const raw = result.stdout.trim();
      const looksLikeJson = raw.startsWith("{") || raw.startsWith("[");

      // Try JSON format first (sinfo --json in Slurm 23+)
      if (looksLikeJson) {
        try {
          const sinfo = JSON.parse(raw);
          if (sinfo.sinfo && Array.isArray(sinfo.sinfo)) {
            // Slurm 23+/24+ format: each entry contains a node group.
            const nodes: any[] = [];
            for (const entry of sinfo.sinfo) {
              const nodeList = entry.nodes?.nodes ?? [];
              const states = entry.node?.state ?? [];
              const state = Array.isArray(states) ? states.join(",").toLowerCase() : String(states).toLowerCase();
              const gres = entry.gres?.total ?? entry.node?.gres ?? "";
              const gresMatch = typeof gres === "string" ? gres.match(/gpu:(\d+)/) : null;
              const gpus = gresMatch ? parseInt(gresMatch[1]) : 0;
              // Memory/cpus fields are nested objects in Slurm 24+; unwrap.
              const cpus = typeof entry.cpus?.total === "number"
                ? entry.cpus.total
                : entry.cpus?.maximum ?? 0;
              const memory = typeof entry.memory?.maximum === "number"
                ? entry.memory.maximum
                : entry.memory?.total ?? 0;
              // slurmd version as the node sees itself — useful for spotting
              // controller/worker version drift (the #1 cause of "Header
              // lengths are longer than data received" errors). Fall back to
              // the versionByNode map we built from `sinfo -N -o %v` because
              // sinfo --json's field name shifts across Slurm releases.
              const versionFromEntry = entry.slurmd_version ?? entry.version ?? "";
              const ipByNodeCfg = Object.fromEntries(
                ((cluster.config as Record<string, unknown>).slurm_hosts_entries as Array<{ hostname: string; ip: string }> ?? [])
                  .map((h) => [h.hostname, h.ip]),
              );
              for (const name of nodeList) {
                nodes.push({
                  name,
                  state: state || "unknown",
                  cpus,
                  memory,
                  gres,
                  gpus,
                  version: versionByNode[name] || versionFromEntry || "",
                  ip: ipByNodeCfg[name] ?? "",
                  partitions: entry.partition?.name ? [entry.partition.name] : [],
                });
              }
            }
            return NextResponse.json({ nodes });
          }
          return NextResponse.json({ nodes: sinfo.nodes ?? [] });
        } catch (parseErr) {
          // JSON-looking but unparseable — surface the error instead of
          // falling through to the pipe parser (which would treat every
          // curly-brace line as a separate node row).
          return NextResponse.json({
            nodes: [],
            error: `Failed to parse sinfo JSON: ${parseErr instanceof Error ? parseErr.message : "Unknown"}`,
          });
        }
      }

      // Fallback: parse line format (Name|State|CPUs|Memory|Gres|Partitions|Version)
      const ipByNode = Object.fromEntries(
        ((cluster.config as Record<string, unknown>).slurm_hosts_entries as Array<{ hostname: string; ip: string }> ?? [])
          .map((h) => [h.hostname, h.ip]),
      );
      const nodes = raw.split("\n").filter(Boolean).map((line) => {
        const [name, state, cpus, memory, gres, partitions, version] = line.split("|");
        const gresStr = gres?.trim() ?? "";
        const gresMatch = gresStr.match(/gpu:(\d+)/);
        const trimmedName = name?.trim() ?? "";
        return {
          name: trimmedName,
          state: state?.trim() ?? "unknown",
          cpus: parseInt(cpus) || 0,
          memory: parseInt(memory) || 0,
          gres: gresStr,
          gpus: gresMatch ? parseInt(gresMatch[1]) : 0,
          version: versionByNode[trimmedName] || version?.trim() || "",
          ip: ipByNode[trimmedName] ?? "",
          partitions: partitions?.trim().split(",").filter(Boolean) ?? [],
        };
      });

      // If parsing dropped everything (malformed sinfo output, line-format
      // mismatch), fall back to DB so the UI still has something to show.
      if (nodes.length === 0) {
        const config = cluster.config as Record<string, unknown>;
        const entries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip?: string }>;
        if (entries.length > 0) {
          return NextResponse.json({
            nodes: entries.map((e) => ({
              name: e.hostname,
              state: "unknown",
              cpus: 0,
              memory: 0,
              partitions: [],
            })),
            warning: "sinfo parsing returned nothing — showing nodes from cluster config as fallback.",
          });
        }
      }

      return NextResponse.json({ nodes });
    } catch (err) {
      return NextResponse.json({ error: `SSH failed: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 504 });
    }
  }

  // NATS mode
  if (cluster.status === "OFFLINE" || cluster.status === "PROVISIONING") {
    return NextResponse.json({ error: "Cluster is not available" }, { status: 503 });
  }

  try {
    const result = await sendCommandAndWait(
      id,
      { request_id: randomUUID(), type: "node_status" },
      30_000
    ) as { stdout?: string; Stdout?: string };

    const raw = result.stdout ?? result.Stdout ?? "";
    try {
      const sinfo = JSON.parse(raw) as { nodes?: unknown[] };
      return NextResponse.json({ nodes: sinfo.nodes ?? [] });
    } catch {
      return NextResponse.json({ nodes: [], raw, error: "Failed to parse sinfo JSON" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Failed to fetch nodes: ${message}` }, { status: 504 });
  }
}
