import { eq } from 'drizzle-orm';
import { users, type Db } from '@prometeo/db';
import type { Role } from '@prometeo/shared';
import { writeAudit } from '../lib/audit';
import { AuthError } from './auth.service';

export interface Actor {
  id: string;
  role: Role;
}

/**
 * Cambia el rol de un usuario. Reglas anti-escalamiento:
 * - Solo SUPER_ADMIN puede asignar roles.
 * - Nadie puede cambiarse el rol a sí mismo.
 */
export async function setUserRole(
  db: Db,
  actor: Actor,
  targetId: string,
  newRole: Role,
  ip?: string | null,
): Promise<void> {
  if (actor.role !== 'SUPER_ADMIN') {
    throw new AuthError(403, 'FORBIDDEN', 'No tienes permisos para asignar roles');
  }
  if (actor.id === targetId) {
    throw new AuthError(403, 'SELF_ROLE_CHANGE', 'No puedes cambiar tu propio rol');
  }
  const [target] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) throw new AuthError(404, 'NOT_FOUND', 'Usuario no encontrado');

  await db.update(users).set({ role: newRole }).where(eq(users.id, targetId));
  await writeAudit(db, {
    actorId: actor.id,
    action: 'user.role_change',
    entityType: 'user',
    entityId: targetId,
    before: { role: target.role },
    after: { role: newRole },
    ip,
  });
}
