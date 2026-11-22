import { Hono } from 'hono';
import { and, asc, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  categories,
  productImages,
  products,
  quoteRequests,
  serviceImages,
  services,
} from '@prometeo/db';
import {
  cartQuoteSchema,
  publicProductsQuerySchema,
  quoteRequestSchema,
  slugParamSchema,
} from '@prometeo/shared';
import type { AppEnv } from '../env';
import { escapeHtml } from '../lib/emails';
import { pageInfo } from '../lib/pagination';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AuthError } from '../services/auth.service';
import { priceCart, summarizeCart } from '../services/cart';
import { loadSettings } from '../services/settings';

/** Endpoints públicos (sin sesión). Solo exponen contenido publicado. */
export const publicRoutes = new Hono<AppEnv>();

// Caché corta en CDN/navegador solo para lecturas.
publicRoutes.use('*', async (c, next) => {
  await next();
  // No pisa un Cache-Control definido por la ruta (p. ej. estado de inscripción: private, no-store).
  if (c.req.method === 'GET' && c.res.status === 200 && !c.res.headers.has('Cache-Control')) {
    c.res.headers.set(
      'Cache-Control',
      'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
    );
  }
});

/** Imagen principal de un producto/servicio. Se califica la tabla exterior para evitar ambigüedad de `id`. */
const primaryImage = (kind: 'product' | 'service') =>
  kind === 'product'
    ? sql<
        string | null
      >`(select i.url from product_images i where i.product_id = "products"."id" order by i.is_primary desc, i.sort_order asc limit 1)`
    : sql<
        string | null
      >`(select i.url from service_images i where i.service_id = "services"."id" order by i.is_primary desc, i.sort_order asc limit 1)`;

publicRoutes.get('/settings', async (c) => c.json({ settings: await loadSettings(c.get('db')) }));

publicRoutes.get('/categories', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      imageUrl: categories.imageUrl,
    })
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return c.json({ items: rows });
});

publicRoutes.get('/products', validate('query', publicProductsQuerySchema), async (c) => {
  const db = c.get('db');
  const { q, category, minPrice, maxPrice, sort, featured, page, pageSize } = c.req.valid('query');
  const filters: SQL[] = [eq(products.status, 'publicado')];
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const cond = or(
      ilike(products.name, like),
      sql`to_tsvector('spanish', ${products.name} || ' ' || ${products.description}) @@ plainto_tsquery('spanish', ${q})`,
    );
    if (cond) filters.push(cond);
  }
  if (category) {
    filters.push(
      sql`${products.categoryId} = (select id from ${categories} where slug = ${category} and is_active = true)`,
    );
  }
  if (minPrice !== undefined) filters.push(gte(products.price, minPrice));
  if (maxPrice !== undefined) filters.push(lte(products.price, maxPrice));
  if (featured) filters.push(eq(products.isFeatured, true));
  const where = and(...filters);
  const order =
    sort === 'precio_asc'
      ? asc(products.price)
      : sort === 'precio_desc'
        ? desc(products.price)
        : desc(products.createdAt);

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(where);
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      price: products.price,
      compareAtPrice: products.compareAtPrice,
      stock: products.stock,
      isUnique: products.isUnique,
      isFeatured: products.isFeatured,
      categoryName: sql<
        string | null
      >`(select name from ${categories} where id = ${products.categoryId})`,
      image: primaryImage('product'),
    })
    .from(products)
    .where(where)
    .orderBy(order, asc(products.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return c.json({ items: rows, ...pageInfo(page, pageSize, countRow?.n ?? 0) });
});

publicRoutes.get('/products/:slug', validate('param', slugParamSchema), async (c) => {
  const db = c.get('db');
  const [row] = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      description: products.description,
      price: products.price,
      compareAtPrice: products.compareAtPrice,
      stock: products.stock,
      sku: products.sku,
      weightGrams: products.weightGrams,
      widthMm: products.widthMm,
      heightMm: products.heightMm,
      depthMm: products.depthMm,
      materials: products.materials,
      isUnique: products.isUnique,
      categoryName: sql<
        string | null
      >`(select name from ${categories} where id = ${products.categoryId})`,
      categorySlug: sql<
        string | null
      >`(select slug from ${categories} where id = ${products.categoryId})`,
    })
    .from(products)
    .where(and(eq(products.slug, c.req.valid('param').slug), eq(products.status, 'publicado')))
    .limit(1);
  if (!row) throw new AuthError(404, 'NOT_FOUND', 'Producto no encontrado');
  const images = await db
    .select({ url: productImages.url, alt: productImages.alt, isPrimary: productImages.isPrimary })
    .from(productImages)
    .where(eq(productImages.productId, row.id))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder));
  return c.json({ item: { ...row, images } });
});

publicRoutes.get('/services', async (c) => {
  const db = c.get('db');
  const rows = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      description: services.description,
      price: services.price,
      mode: services.mode,
      image: primaryImage('service'),
    })
    .from(services)
    .where(eq(services.status, 'publicado'))
    .orderBy(asc(services.sortOrder), asc(services.name));
  return c.json({ items: rows });
});

publicRoutes.get('/services/:slug', validate('param', slugParamSchema), async (c) => {
  const db = c.get('db');
  const [row] = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      description: services.description,
      price: services.price,
      mode: services.mode,
    })
    .from(services)
    .where(and(eq(services.slug, c.req.valid('param').slug), eq(services.status, 'publicado')))
    .limit(1);
  if (!row) throw new AuthError(404, 'NOT_FOUND', 'Servicio no encontrado');
  const images = await db
    .select({ url: serviceImages.url, alt: serviceImages.alt, isPrimary: serviceImages.isPrimary })
    .from(serviceImages)
    .where(eq(serviceImages.serviceId, row.id))
    .orderBy(desc(serviceImages.isPrimary), asc(serviceImages.sortOrder));
  return c.json({ item: { ...row, images } });
});

/**
 * Recalcula el carrito con precios y stock reales del servidor.
 * El cliente solo aporta ids y cantidades: nunca se confía en precios del navegador.
 */
publicRoutes.post(
  '/cart/quote',
  rateLimit('RL_PUBLIC', 'cart'),
  validate('json', cartQuoteSchema),
  async (c) => {
    const db = c.get('db');
    const lines = await priceCart(db, c.req.valid('json').items);
    const settings = await loadSettings(db);
    const { subtotal, shipping, total } = summarizeCart(lines, settings);
    return c.json({
      lines,
      subtotal,
      shipping,
      total,
      freeShippingThreshold: settings.free_shipping_threshold,
    });
  },
);

/** Solicitud de cotización / mensaje de contacto. */
publicRoutes.post(
  '/quotes',
  rateLimit('RL_PUBLIC', 'quote'),
  validate('json', quoteRequestSchema),
  async (c) => {
    const db = c.get('db');
    const input = c.req.valid('json');
    if (input.website) return c.json({ ok: true }, 201); // honeypot: se descarta en silencio

    let serviceName: string | null = null;
    if (input.serviceId) {
      const [s] = await db
        .select({ name: services.name })
        .from(services)
        .where(and(eq(services.id, input.serviceId), eq(services.status, 'publicado')))
        .limit(1);
      if (!s) throw new AuthError(400, 'INVALID_SERVICE', 'El servicio seleccionado no existe');
      serviceName = s.name;
    }
    await db.insert(quoteRequests).values({
      serviceId: input.serviceId,
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      desiredDate: input.desiredDate ? new Date(`${input.desiredDate}T12:00:00-05:00`) : null,
      details: input.details,
    });

    // Aviso al taller (si hay correo configurado). Un fallo de correo no debe perder la solicitud.
    const settings = await loadSettings(db);
    const to = settings.contact.email;
    if (to) {
      const subject = serviceName
        ? `Nueva cotización: ${serviceName}`
        : 'Nuevo mensaje de contacto';
      const body = `Nombre: ${input.name}\nCorreo: ${input.email}\nTeléfono: ${input.phone ?? '—'}\nFecha deseada: ${input.desiredDate ?? '—'}\n\n${input.details}`;
      await c
        .get('mailer')
        .send({
          to,
          subject,
          text: body,
          html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
        })
        .catch(() => undefined);
    }
    return c.json({ ok: true }, 201);
  },
);
