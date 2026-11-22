import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import { hashPassword } from '@prometeo/shared';
import * as s from '../src/schema';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (ver .env.example)`);
  return v;
}

const db = drizzle(neon(required('DATABASE_URL')), { schema: s });

async function main() {
  const email = required('ADMIN_EMAIL').toLowerCase();
  const password = required('ADMIN_PASSWORD');
  if (password.length < 10) throw new Error('ADMIN_PASSWORD debe tener al menos 10 caracteres');

  // Admin inicial (idempotente: no sobrescribe si ya existe)
  await db
    .insert(s.users)
    .values({
      email,
      passwordHash: await hashPassword(password),
      name: process.env.ADMIN_NAME ?? 'Administrador',
      role: 'SUPER_ADMIN',
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing();

  const cats = [
    { name: 'Tazas', slug: 'tazas', sortOrder: 1 },
    { name: 'Platos', slug: 'platos', sortOrder: 2 },
    { name: 'Jarrones', slug: 'jarrones', sortOrder: 3 },
    { name: 'Macetas', slug: 'macetas', sortOrder: 4 },
  ];
  await db.insert(s.categories).values(cats).onConflictDoNothing();
  const [tazas] = await db
    .select()
    .from(s.categories)
    .where(sql`slug = 'tazas'`)
    .limit(1);
  const [jarrones] = await db
    .select()
    .from(s.categories)
    .where(sql`slug = 'jarrones'`)
    .limit(1);

  await db
    .insert(s.products)
    .values([
      {
        name: 'Taza Arcilla',
        slug: 'taza-arcilla',
        description: 'Taza de gres esmaltada a mano.',
        price: 45000,
        stock: 12,
        sku: 'TAZ-001',
        categoryId: tazas?.id,
        status: 'publicado',
        isFeatured: true,
      },
      {
        name: 'Jarrón Luna',
        slug: 'jarron-luna',
        description: 'Pieza única torneada.',
        price: 180000,
        stock: 1,
        sku: 'JAR-001',
        categoryId: jarrones?.id,
        status: 'publicado',
        isUnique: true,
        isFeatured: true,
      },
    ])
    .onConflictDoNothing();

  const [course] = await db
    .insert(s.courses)
    .values({
      name: 'Iniciación al torno',
      slug: 'iniciacion-al-torno',
      description: 'Aprende las bases del torno de alfarería.',
      level: 'Principiante',
      durationText: '4 sesiones de 3 horas',
      includes: 'Materiales y horneado incluidos',
      status: 'publicado',
    })
    .onConflictDoNothing()
    .returning();

  if (course) {
    const [edition] = await db
      .insert(s.courseEditions)
      .values({
        courseId: course.id,
        location: 'Taller Prometeo',
        instructor: 'Equipo Prometeo',
        maxSeats: 8,
        price: 320000,
        enrollmentDeadline: new Date(Date.now() + 20 * 864e5),
        allowedPaymentModes: ['total', 'reserva', 'abono', 'lista'],
      })
      .returning();
    if (edition) {
      const start = Date.now() + 30 * 864e5;
      await db.insert(s.editionSessions).values(
        [0, 7, 14, 21].map((d) => ({
          editionId: edition.id,
          startsAt: new Date(start + d * 864e5),
          endsAt: new Date(start + d * 864e5 + 3 * 36e5),
        })),
      );
    }
  }

  await db
    .insert(s.siteSettings)
    .values([
      { key: 'shipping_flat_rate', value: 12000 },
      { key: 'free_shipping_threshold', value: 250000 },
    ])
    .onConflictDoNothing();

  console.log('Seed completado.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
