import { Hono, type Context } from 'hono';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  courseEditions,
  courseImages,
  courses,
  editionSessions,
  enrollments,
  users,
} from '@prometeo/db';
import {
  PAYMENT_MODE_LABELS,
  computeDeposit,
  createEnrollmentSchema,
  pendingAmount,
  secureSeatSchema,
  slugParamSchema,
  tokenParamSchema,
} from '@prometeo/shared';
import type { AppEnv } from '../env';
import { adminNewEnrollment, enrollmentReceived } from '../lib/enrollment-emails';
import { optionalUser } from '../lib/optional-user';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AuthError } from '../services/auth.service';
import { resolveGuestLink } from '../services/guest-links';
import {
  createEnrollment,
  emailContext,
  safeSend,
  secureSeat,
} from '../services/enrollments.service';
import { loadPublicEditions } from '../services/public-courses';
import { loadSettings } from '../services/settings';

export const publicCoursesRoutes = new Hono<AppEnv>();

const COURSE_IMG = sql<
  string | null
>`(select i.url from course_images i where i.course_id = "courses"."id" order by i.is_primary desc, i.sort_order asc limit 1)`;

publicCoursesRoutes.get('/courses', async (c) => {
  const db = c.get('db');
  const list = await db
    .select({
      id: courses.id,
      name: courses.name,
      slug: courses.slug,
      description: courses.description,
      level: courses.level,
      durationText: courses.durationText,
      image: COURSE_IMG,
    })
    .from(courses)
    .where(eq(courses.status, 'publicado'))
    .orderBy(asc(courses.name));
  const editions = await loadPublicEditions(db);
  const items = list.map((course) => {
    const mine = editions.filter((e) => e.courseId === course.id && e.open);
    const next = mine[0];
    return {
      ...course,
      nextEdition: next
        ? {
            id: next.id,
            startsAt: next.firstStart,
            seatsLeft: next.seatsLeft,
            price: next.price,
            full: next.full,
          }
        : null,
      fromPrice: mine.length ? Math.min(...mine.map((e) => e.price)) : null,
    };
  });
  return c.json({ items });
});

publicCoursesRoutes.get('/courses/:slug', validate('param', slugParamSchema), async (c) => {
  const db = c.get('db');
  const [course] = await db
    .select({
      id: courses.id,
      name: courses.name,
      slug: courses.slug,
      description: courses.description,
      level: courses.level,
      durationText: courses.durationText,
      includes: courses.includes,
    })
    .from(courses)
    .where(and(eq(courses.slug, c.req.valid('param').slug), eq(courses.status, 'publicado')))
    .limit(1);
  if (!course) throw new AuthError(404, 'NOT_FOUND', 'Curso no encontrado');
  const images = await db
    .select({ url: courseImages.url, alt: courseImages.alt })
    .from(courseImages)
    .where(eq(courseImages.courseId, course.id))
    .orderBy(desc(courseImages.isPrimary), asc(courseImages.sortOrder));
  const editions = await loadPublicEditions(db, { courseId: course.id });
  return c.json({ item: { ...course, images, editions } });
});

/** Inscripción pública (invitado o con sesión). La verificación de cupo es transaccional. */
publicCoursesRoutes.post(
  '/enrollments',
  rateLimit('RL_PUBLIC', 'enroll'),
  validate('json', createEnrollmentSchema),
  async (c) => {
    const input = c.req.valid('json');
    if (input.website) return c.json({ ok: true }, 201); // honeypot

    // Si hay sesión y el correo coincide con el de la cuenta verificada, se vincula al usuario.
    let userId: string | null = null;
    const session = await optionalUser(c);
    if (session) {
      const [u] = await c
        .get('db')
        .select({ id: users.id, email: users.email, verified: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, session.id))
        .limit(1);
      if (u && u.verified && u.email.toLowerCase() === input.email) userId = u.id;
    }

    const created = await createEnrollment(c.get('openPool'), input, userId);
    const db = c.get('db');
    const ctx = await emailContext(db, created.enrollment, c.env.WEB_URL, created.token);
    const mailer = c.get('mailer');
    await safeSend(mailer, enrollmentReceived(ctx));
    const adminTo = (await loadSettings(db)).contact.email;
    if (adminTo)
      await safeSend(mailer, adminNewEnrollment(adminTo, ctx, created.enrollment.contactEmail));
    return c.json(
      {
        enrollment: {
          id: created.enrollment.id,
          status: created.enrollment.status,
          paymentMode: created.enrollment.paymentMode,
          totalAmount: created.enrollment.totalAmount,
          reservedUntil: created.enrollment.reservedUntil,
        },
        token: created.token,
        depositAmount: created.depositAmount,
        seatsLeft: created.seatsLeft,
      },
      201,
    );
  },
);

async function enrollmentByToken(c: Context<AppEnv>, token: string) {
  const db = c.get('db');
  const id = await resolveGuestLink(db, 'enrollment', token);
  if (!id) throw new AuthError(404, 'NOT_FOUND', 'El enlace no es válido o venció');
  const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
  if (!enrollment) throw new AuthError(404, 'NOT_FOUND', 'Inscripción no encontrada');
  return enrollment;
}

const maskEmail = (e: string) => e.replace(/^(.{2})[^@]*(@.*)$/, '$1•••$2');

publicCoursesRoutes.get(
  '/enrollments/:token',
  rateLimit('RL_PUBLIC', 'enroll-status'),
  validate('param', tokenParamSchema),
  async (c) => {
    const db = c.get('db');
    const e = await enrollmentByToken(c, c.req.valid('param').token);
    const [row] = await db
      .select({ courseName: courses.name, courseSlug: courses.slug, edition: courseEditions })
      .from(courseEditions)
      .innerJoin(courses, eq(courses.id, courseEditions.courseId))
      .where(eq(courseEditions.id, e.editionId))
      .limit(1);
    const sessions = await db
      .select({ startsAt: editionSessions.startsAt, endsAt: editionSessions.endsAt })
      .from(editionSessions)
      .where(eq(editionSessions.editionId, e.editionId))
      .orderBy(asc(editionSessions.startsAt));
    const pub = row
      ? (await loadPublicEditions(db, { courseId: row.edition.courseId })).find(
          (x) => x.id === e.editionId,
        )
      : undefined;
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      enrollment: {
        status: e.status,
        paymentMode: e.paymentMode,
        paymentModeLabel: PAYMENT_MODE_LABELS[e.paymentMode],
        totalAmount: e.totalAmount,
        paidAmount: e.paidAmount,
        pendingAmount: pendingAmount(e.totalAmount, e.paidAmount),
        reservedUntil: e.reservedUntil,
        balanceDueAt: e.balanceDueAt,
        name: e.contactName,
        email: maskEmail(e.contactEmail),
        createdAt: e.createdAt,
      },
      course: { name: row?.courseName ?? '', slug: row?.courseSlug ?? '' },
      edition: row && {
        location: row.edition.location,
        instructor: row.edition.instructor,
        status: row.edition.status,
        enrollmentDeadline: row.edition.enrollmentDeadline,
        allowedPaymentModes: row.edition.allowedPaymentModes,
        depositAmount: computeDeposit(
          e.totalAmount,
          row.edition.depositType,
          row.edition.depositValue,
        ),
        seatsLeft: pub?.seatsLeft ?? 0,
        canSecure: e.status === 'lista' && Boolean(pub?.open) && (pub?.seatsLeft ?? 0) > 0,
        sessions,
      },
    });
  },
);

/** Quien está en lista asegura el cupo si aún hay disponibles. */
publicCoursesRoutes.post(
  '/enrollments/:token/secure',
  rateLimit('RL_PUBLIC', 'enroll-secure'),
  validate('param', tokenParamSchema),
  validate('json', secureSeatSchema),
  async (c) => {
    const { token } = c.req.valid('param');
    const updated = await secureSeat(c.get('openPool'), token, c.req.valid('json').mode);
    await safeSend(
      c.get('mailer'),
      enrollmentReceived(await emailContext(c.get('db'), updated, c.env.WEB_URL, token)),
    );
    return c.json({ ok: true, status: updated.status, reservedUntil: updated.reservedUntil });
  },
);
