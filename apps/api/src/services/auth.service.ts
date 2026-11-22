import { and, eq, isNull, sql } from 'drizzle-orm';
import { authTokens, enrollments, orders, refreshTokens, users, type Db } from '@prometeo/db';
import {
  REFRESH_TOKEN_TTL_SECONDS,
  RESET_PASSWORD_TTL_SECONDS,
  VERIFY_EMAIL_TTL_SECONDS,
  hashPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
  type AuthTokenType,
  type RegisterInput,
  type Role,
} from '@prometeo/shared';
import { resetPasswordMessage, verifyEmailMessage } from '../lib/emails';
import { signAccessToken } from '../lib/jwt';
import type { Mailer } from '../lib/mailer';

export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthDeps {
  db: Db;
  mailer: Mailer;
  jwtSecret: string;
  webUrl: string;
}

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  emailVerified: boolean;
}

type UserRow = typeof users.$inferSelect;

const INVALID_CREDENTIALS = new AuthError(
  401,
  'INVALID_CREDENTIALS',
  'Correo o contraseña incorrectos',
);
const INVALID_SESSION = new AuthError(
  401,
  'INVALID_SESSION',
  'Tu sesión no es válida. Inicia sesión de nuevo',
);
const INVALID_TOKEN = new AuthError(400, 'INVALID_TOKEN', 'El enlace no es válido o ya venció');

// Hash de relleno: igualamos el tiempo de respuesta cuando el correo no existe.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('contraseña-de-relleno'));

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    emailVerified: u.emailVerifiedAt !== null,
  };
}

async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row;
}

async function createAuthToken(
  db: Db,
  userId: string,
  type: AuthTokenType,
  ttlSeconds: number,
): Promise<string> {
  const token = randomToken(32);
  await db.insert(authTokens).values({
    userId,
    type,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
  return token;
}

/** Consume el token de forma atómica (un solo uso): UPDATE ... WHERE used_at IS NULL RETURNING. */
async function consumeAuthToken(db: Db, token: string, type: AuthTokenType): Promise<string> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, await sha256Hex(token)),
        eq(authTokens.type, type),
        isNull(authTokens.usedAt),
        sql`${authTokens.expiresAt} > now()`,
      ),
    )
    .returning({ userId: authTokens.userId });
  if (!row) throw INVALID_TOKEN;
  return row.userId;
}

async function sendVerification(deps: AuthDeps, user: UserRow): Promise<void> {
  const token = await createAuthToken(deps.db, user.id, 'verify_email', VERIFY_EMAIL_TTL_SECONDS);
  const url = `${deps.webUrl}/verificar-email?token=${token}`;
  await deps.mailer.send(verifyEmailMessage(user.email, user.name, url));
}

async function createRefreshToken(db: Db, userId: string, familyId: string, meta: SessionMeta) {
  const token = randomToken(48);
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId,
      familyId,
      tokenHash: await sha256Hex(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    })
    .returning({ id: refreshTokens.id });
  if (!row) throw new Error('No se pudo crear el refresh token');
  return { token, id: row.id };
}

async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

async function startSession(
  deps: AuthDeps,
  user: UserRow,
  familyId: string,
  meta: SessionMeta,
): Promise<Session> {
  const [accessToken, refresh] = await Promise.all([
    signAccessToken(deps.jwtSecret, { id: user.id, role: user.role }),
    createRefreshToken(deps.db, user.id, familyId, meta),
  ]);
  return { accessToken, refreshToken: refresh.token, user: toPublicUser(user) };
}

/**
 * Registro. Respuesta idéntica exista o no el correo (evita enumeración de cuentas).
 */
export async function register(deps: AuthDeps, input: RegisterInput): Promise<void> {
  if (await findUserByEmail(deps.db, input.email)) return;
  const passwordHash = await hashPassword(input.password);
  try {
    const [user] = await deps.db
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        name: input.name,
        phone: input.phone ?? null,
        role: 'CLIENTE',
        dataPolicyAcceptedAt: new Date(),
      })
      .returning();
    if (user) await sendVerification(deps, user);
  } catch (err) {
    // Carrera: otro request creó el mismo correo entre la búsqueda y el insert.
    if (!(await findUserByEmail(deps.db, input.email))) throw err;
  }
}

export async function login(
  deps: AuthDeps,
  email: string,
  password: string,
  meta: SessionMeta,
): Promise<Session> {
  const user = await findUserByEmail(deps.db, email);
  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok || !user.isActive) throw INVALID_CREDENTIALS;
  return startSession(deps, user, crypto.randomUUID(), meta);
}

/**
 * Refresh rotativo. Un token ya usado/revocado que reaparece = posible robo:
 * se revoca toda la familia.
 */
export async function refresh(deps: AuthDeps, token: string, meta: SessionMeta): Promise<Session> {
  const { db } = deps;
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, await sha256Hex(token)))
    .limit(1);
  if (!row) throw INVALID_SESSION;

  if (row.revokedAt || row.replacedById) {
    await revokeFamily(db, row.familyId);
    throw INVALID_SESSION;
  }
  if (row.expiresAt.getTime() <= Date.now()) throw INVALID_SESSION;

  // Reclamo atómico: solo un request concurrente puede rotar este token.
  const claimed = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  if (claimed.length === 0) {
    await revokeFamily(db, row.familyId);
    throw INVALID_SESSION;
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || !user.isActive) {
    await revokeFamily(db, row.familyId);
    throw INVALID_SESSION;
  }

  const session = await startSession(deps, user, row.familyId, meta);
  const [next] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, await sha256Hex(session.refreshToken)))
    .limit(1);
  if (next)
    await db
      .update(refreshTokens)
      .set({ replacedById: next.id })
      .where(eq(refreshTokens.id, row.id));
  return session;
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.tokenHash, await sha256Hex(token)), isNull(refreshTokens.revokedAt)),
    );
}

/** Verifica el correo y vincula pedidos/inscripciones hechos como invitado con ese correo. */
export async function verifyEmail(db: Db, token: string): Promise<void> {
  const userId = await consumeAuthToken(db, token, 'verify_email');
  const [user] = await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email });
  if (!user) throw INVALID_TOKEN;
  const email = user.email.toLowerCase();
  await db
    .update(orders)
    .set({ userId: user.id })
    .where(and(isNull(orders.userId), sql`lower(${orders.contactEmail}) = ${email}`));
  await db
    .update(enrollments)
    .set({ userId: user.id })
    .where(and(isNull(enrollments.userId), sql`lower(${enrollments.contactEmail}) = ${email}`));
}

export async function forgotPassword(deps: AuthDeps, email: string): Promise<void> {
  const user = await findUserByEmail(deps.db, email);
  if (!user || !user.isActive) return; // respuesta idéntica siempre
  const token = await createAuthToken(
    deps.db,
    user.id,
    'reset_password',
    RESET_PASSWORD_TTL_SECONDS,
  );
  const url = `${deps.webUrl}/restablecer-clave?token=${token}`;
  await deps.mailer.send(resetPasswordMessage(user.email, user.name, url));
}

export async function resetPassword(db: Db, token: string, newPassword: string): Promise<void> {
  const userId = await consumeAuthToken(db, token, 'reset_password');
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.id, userId));
  // Cierra todas las sesiones existentes.
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function getUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}
