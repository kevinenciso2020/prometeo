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

  // Productos demo adicionales (para que la tienda no se vea vacía).
  const [platos] = await db
    .select()
    .from(s.categories)
    .where(sql`slug = 'platos'`)
    .limit(1);
  await db
    .insert(s.products)
    .values([
      {
        name: 'Platos Océano',
        slug: 'platos-oceano',
        description: 'Set de platos con esmalte azul cielo y borde irregular, hechos a mano.',
        price: 120000,
        stock: 6,
        sku: 'PLA-001',
        categoryId: platos?.id,
        status: 'publicado',
        isFeatured: true,
      },
      {
        name: 'Tazas Hueso',
        slug: 'tazas-hueso',
        description: 'Tazas modeladas a mano en arcilla blanca, sin esmalte exterior.',
        price: 52000,
        stock: 10,
        sku: 'TAZ-002',
        categoryId: tazas?.id,
        status: 'publicado',
        isFeatured: true,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(s.services)
    .values([
      {
        name: 'Vajillas a la medida',
        slug: 'vajillas-a-la-medida',
        description:
          'Diseñamos y hacemos tu vajilla: formas, esmaltes y cantidades a tu medida. Cuéntanos qué necesitas y te cotizamos.',
        mode: 'cotizacion',
        status: 'publicado',
      },
      {
        name: 'Taller para grupos',
        slug: 'taller-para-grupos',
        description:
          'Una tarde de barro para equipos, cumpleaños o despedidas. Materiales y horneado incluidos.',
        mode: 'cotizacion',
        status: 'publicado',
      },
    ])
    .onConflictDoNothing();

  // Imágenes demo (archivos en apps/web/public/img). Solo si el registro aún no tiene imágenes.
  const demoImg = (file: string, alt: string, primary = true) => ({
    url: `/img/${file}.jpg`,
    publicId: `local/${file}`,
    alt,
    isPrimary: primary,
  });
  const productImgs: Record<string, [string, string]> = {
    'taza-arcilla': ['tazas-moteadas', 'Tazas de gres moteado con base color miel'],
    'jarron-luna': ['jarrones-grises', 'Tres jarrones de cerámica gris sobre fondo oscuro'],
    'platos-oceano': ['platos-azules', 'Platos de cerámica azul claro apilados'],
    'tazas-hueso': ['tazas-blancas', 'Tazas blancas modeladas a mano, apiladas'],
  };
  for (const [slug, [file, alt]] of Object.entries(productImgs)) {
    const [row] = await db
      .select()
      .from(s.products)
      .where(sql`slug = ${slug}`)
      .limit(1);
    if (!row) continue;
    const has = await db
      .select()
      .from(s.productImages)
      .where(sql`product_id = ${row.id}`)
      .limit(1);
    if (!has.length)
      await db.insert(s.productImages).values({ productId: row.id, ...demoImg(file, alt) });
  }
  const serviceImgs: Record<string, [string, string]> = {
    'vajillas-a-la-medida': ['platos-azules', 'Vajilla azul hecha a mano'],
    'taller-para-grupos': ['terracota', 'Piezas de terracota secándose al sol'],
  };
  for (const [slug, [file, alt]] of Object.entries(serviceImgs)) {
    const [row] = await db
      .select()
      .from(s.services)
      .where(sql`slug = ${slug}`)
      .limit(1);
    if (!row) continue;
    const has = await db
      .select()
      .from(s.serviceImages)
      .where(sql`service_id = ${row.id}`)
      .limit(1);
    if (!has.length)
      await db.insert(s.serviceImages).values({ serviceId: row.id, ...demoImg(file, alt) });
  }

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

  const [iniciacion] = await db
    .select()
    .from(s.courses)
    .where(sql`slug = 'iniciacion-al-torno'`)
    .limit(1);
  if (iniciacion) {
    const has = await db
      .select()
      .from(s.courseImages)
      .where(sql`course_id = ${iniciacion.id}`)
      .limit(1);
    if (!has.length)
      await db.insert(s.courseImages).values([
        {
          courseId: iniciacion.id,
          ...demoImg('torno-manos', 'Manos modelando una pieza en el torno'),
        },
        {
          courseId: iniciacion.id,
          ...demoImg('hero-torno', 'Manos de alfarero sobre el torno, en blanco y negro', false),
          sortOrder: 1,
        },
      ]);
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
