import { and, eq, sql } from 'drizzle-orm';
import { products, services, type Db } from '@prometeo/db';
import type { CartLine, PricingLine, ShippingConfig } from '@prometeo/shared';
import type { LoadedSettings } from './settings';

export interface PricedLine {
  type: 'product' | 'service';
  id: string;
  categoryId?: string | null;
  name?: string;
  slug?: string;
  image?: string | null;
  unitPrice?: number;
  quantity?: number;
  stock?: number | null;
  available: boolean;
  lineTotal?: number;
  reason?: string | null;
}

const PRODUCT_IMG = sql<
  string | null
>`(select i.url from product_images i where i.product_id = "products"."id" order by i.is_primary desc, i.sort_order asc limit 1)`;
const SERVICE_IMG = sql<
  string | null
>`(select i.url from service_images i where i.service_id = "services"."id" order by i.is_primary desc, i.sort_order asc limit 1)`;

/**
 * Recalcula el carrito con precios y stock REALES de la base de datos.
 * El cliente solo aporta ids y cantidades: nunca se confía en precios del navegador.
 */
export async function priceCart(db: Db, items: CartLine[]): Promise<PricedLine[]> {
  const lines: PricedLine[] = [];
  for (const it of items) {
    if (it.type === 'product') {
      const [p] = await db
        .select({
          id: products.id,
          name: products.name,
          slug: products.slug,
          price: products.price,
          stock: products.stock,
          isUnique: products.isUnique,
          categoryId: products.categoryId,
          image: PRODUCT_IMG,
        })
        .from(products)
        .where(and(eq(products.id, it.id), eq(products.status, 'publicado')))
        .limit(1);
      if (!p) {
        lines.push({ type: it.type, id: it.id, available: false, reason: 'Ya no está disponible' });
        continue;
      }
      const qty = Math.min(it.quantity, p.isUnique ? 1 : 20);
      const ok = p.stock >= qty;
      lines.push({
        type: it.type,
        id: p.id,
        categoryId: p.categoryId,
        name: p.name,
        slug: p.slug,
        image: p.image,
        unitPrice: p.price,
        quantity: qty,
        stock: p.stock,
        available: ok,
        lineTotal: ok ? p.price * qty : 0,
        reason: ok ? null : p.stock === 0 ? 'Agotado' : `Solo quedan ${p.stock}`,
      });
    } else {
      const [s] = await db
        .select({
          id: services.id,
          name: services.name,
          slug: services.slug,
          price: services.price,
          image: SERVICE_IMG,
        })
        .from(services)
        .where(
          and(
            eq(services.id, it.id),
            eq(services.status, 'publicado'),
            eq(services.mode, 'pago_online'),
          ),
        )
        .limit(1);
      if (!s || s.price === null) {
        lines.push({ type: it.type, id: it.id, available: false, reason: 'Ya no está disponible' });
        continue;
      }
      lines.push({
        type: it.type,
        id: s.id,
        name: s.name,
        slug: s.slug,
        image: s.image,
        unitPrice: s.price,
        quantity: it.quantity,
        stock: null,
        available: true,
        lineTotal: s.price * it.quantity,
        reason: null,
      });
    }
  }
  return lines;
}

/** Líneas disponibles convertidas para el motor de precios. */
export function toPricingLines(lines: PricedLine[]): PricingLine[] {
  return lines
    .filter((l) => l.available)
    .map((l) => ({
      kind: l.type,
      id: l.id,
      categoryId: l.categoryId ?? null,
      unitPrice: l.unitPrice ?? 0,
      quantity: l.quantity ?? 1,
    }));
}

export function shippingConfig(settings: LoadedSettings): ShippingConfig {
  return {
    flatRate: Number(settings.shipping_flat_rate),
    freeThreshold:
      settings.free_shipping_threshold === null ? null : Number(settings.free_shipping_threshold),
  };
}
