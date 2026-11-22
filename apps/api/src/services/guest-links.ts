import { and, eq, sql } from 'drizzle-orm';
import { guestLinks, type Db } from '@prometeo/db';
import { randomToken, sha256Hex } from '@prometeo/shared';

export const GUEST_LINK_TTL_MS = 180 * 24 * 3_600_000;
export type GuestSubject = 'order' | 'enrollment';

/** Emite un enlace seguro (token aleatorio de 256 bits; en la BD solo se guarda su hash). */
export async function issueGuestLink(
  db: Db,
  type: GuestSubject,
  subjectId: string,
  email: string,
): Promise<string> {
  const token = randomToken(32);
  await db.insert(guestLinks).values({
    tokenHash: await sha256Hex(token),
    subjectType: type,
    subjectId,
    email,
    expiresAt: new Date(Date.now() + GUEST_LINK_TTL_MS),
  });
  return token;
}

/** Devuelve el id del pedido/inscripción al que apunta el token, o null si no existe o venció. */
export async function resolveGuestLink(
  db: Db,
  type: GuestSubject,
  token: string,
): Promise<string | null> {
  const [link] = await db
    .select({ subjectId: guestLinks.subjectId })
    .from(guestLinks)
    .where(
      and(
        eq(guestLinks.tokenHash, await sha256Hex(token)),
        eq(guestLinks.subjectType, type),
        sql`${guestLinks.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return link?.subjectId ?? null;
}
