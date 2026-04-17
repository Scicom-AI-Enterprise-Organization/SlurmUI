import { prisma } from "./prisma";
import { auth } from "./auth";

interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record an audit log entry. Automatically captures the current user from
 * the session. Safe to call from API routes — won't throw if session is missing.
 */
export async function logAudit(entry: AuditEntry) {
  let userId: string | undefined;
  let userEmail: string | undefined;

  try {
    const session = await auth();
    if (session?.user) {
      userId = (session.user as any).id;
      userEmail = session.user.email ?? undefined;
    }
  } catch {}

  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        userId,
        userEmail,
        metadata: entry.metadata ? (entry.metadata as object) : undefined,
      },
    });
  } catch (err) {
    // Never let audit logging break the main operation
    console.error("[audit] Failed to write audit log:", err);
  }
}
