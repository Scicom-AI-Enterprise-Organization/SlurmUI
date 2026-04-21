import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface P { params: Promise<{ id: string }> }

// Returns { [slurmJobId]: jobUUID } for every job on this cluster that has
// a slurmJobId set. Used by the queue tab so each row's Slurm ID can link
// to the SlurmUI job detail page — only jobs SlurmUI itself submitted end
// up here; anything else won't have a mapping and should render as plain
// text in the UI.
export async function GET(_req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await prisma.job.findMany({
    where: { clusterId: id, slurmJobId: { not: null } },
    select: { id: true, slurmJobId: true },
  });

  const map: Record<string, string> = {};
  for (const r of rows) if (r.slurmJobId !== null) map[String(r.slurmJobId)] = r.id;
  return NextResponse.json({ map });
}
