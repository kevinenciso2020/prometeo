import { auditLogs, type Db } from '@prometeo/db';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
  });
}
