import { prisma } from "@/lib/prisma";
import { AuditLogTable } from "@/components/admin/audit-log-table";

interface PageProps {
  searchParams: Promise<{
    page?: string;
    action?: string;
    entity?: string;
    search?: string;
    from?: string;
    to?: string;
  }>;
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const limit = 50;
  const action = params.action || undefined;
  const entity = params.entity || undefined;
  const search = params.search || undefined;
  const from = params.from || "";
  const to = params.to || "";

  const where: any = {};
  if (action) where.action = action;
  if (entity) where.entity = entity;
  if (search) {
    where.OR = [
      { action: { contains: search, mode: "insensitive" } },
      { entity: { contains: search, mode: "insensitive" } },
      { userEmail: { contains: search, mode: "insensitive" } },
      { entityId: { contains: search, mode: "insensitive" } },
    ];
  }
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) range.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        range.lte = d;
      }
    }
    if (Object.keys(range).length > 0) where.createdAt = range;
  }

  const [logs, total, actions, entities] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
    prisma.auditLog.findMany({
      select: { entity: true },
      distinct: ["entity"],
      orderBy: { entity: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Audit Log</h1>
        <p className="text-muted-foreground mt-1">Track all admin actions across the platform</p>
      </div>
      <AuditLogTable
        logs={JSON.parse(JSON.stringify(logs))}
        pagination={{ page, limit, total, totalPages: Math.ceil(total / limit) }}
        filters={{
          action: action ?? "",
          entity: entity ?? "",
          search: search ?? "",
          from,
          to,
        }}
        availableActions={actions.map((a) => a.action)}
        availableEntities={entities.map((e) => e.entity)}
      />
    </div>
  );
}
