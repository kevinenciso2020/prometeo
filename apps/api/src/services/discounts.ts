import { and, eq, inArray, sql } from 'drizzle-orm';
import { couponRedemptions, coupons, type Db } from '@prometeo/db';
import {
  COUPON_MESSAGES,
  priceOrder,
  type CouponRejection,
  type CouponRule,
  type CouponUsage,
  type PricedOrder,
  type PricingLine,
  type ShippingConfig,
} from '@prometeo/shared';
import { AuthError } from './auth.service';

type CouponRow = typeof coupons.$inferSelect;

export function toRule(row: CouponRow): CouponRule {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    appliesTo: row.appliesTo,
    targetIds: row.targetIds,
    minPurchase: row.minPurchase,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    maxUses: row.maxUses,
    maxUsesPerEmail: row.maxUsesPerEmail,
    isAutomatic: row.isAutomatic,
    isActive: row.isActive,
  };
}

/** Usos aprobados (solo existen redenciones cuando el pago se aprobó). */
export async function couponUsage(
  db: Db,
  couponId: string,
  email: string | null,
): Promise<CouponUsage> {
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(couponRedemptions)
    .where(eq(couponRedemptions.couponId, couponId));
  let byEmail: number | null = null;
  if (email) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(
        and(
          eq(couponRedemptions.couponId, couponId),
          sql`lower(${couponRedemptions.email}) = ${email.toLowerCase()}`,
        ),
      );
    byEmail = row?.n ?? 0;
  }
  return { total: total?.n ?? 0, byEmail };
}

export type CodeStatus = 'none' | 'applied' | 'outranked' | 'rejected';

export interface DiscountResult {
  priced: PricedOrder;
  /** Cupón (con código o automático) efectivamente aplicado. */
  coupon: CouponRow | null;
  codeStatus: CodeStatus;
  reason: CouponRejection | null;
  message: string | null;
}

/**
 * Calcula precios con descuentos usando el motor puro de `shared/pricing`.
 * Candidatos: el código del cliente (si lo hay) + todos los descuentos automáticos activos.
 * No se acumulan: gana el que más beneficia.
 */
export async function resolveDiscount(
  db: Db,
  input: {
    lines: PricingLine[];
    shipping: ShippingConfig;
    code: string | null;
    email: string | null;
    now?: Date;
  },
): Promise<DiscountResult> {
  const now = input.now ?? new Date();
  const autos = await db
    .select()
    .from(coupons)
    .where(and(eq(coupons.isAutomatic, true), eq(coupons.isActive, true)));
  let explicit: CouponRow | undefined;
  if (input.code) {
    [explicit] = await db
      .select()
      .from(coupons)
      .where(
        and(
          eq(coupons.isAutomatic, false),
          sql`lower(${coupons.code}) = ${input.code.toLowerCase()}`,
        ),
      )
      .limit(1);
  }

  const rows = explicit ? [explicit, ...autos] : autos;
  const candidates = await Promise.all(
    rows.map(async (row) => ({
      row,
      rule: toRule(row),
      usage: await couponUsage(db, row.id, input.email),
    })),
  );
  const priced = priceOrder({
    lines: input.lines,
    shipping: input.shipping,
    now,
    coupons: candidates.map((c) => ({ rule: c.rule, usage: c.usage })),
  });
  const applied = priced.applied
    ? (candidates.find((c) => c.row.id === priced.applied?.couponId)?.row ?? null)
    : null;

  if (!input.code)
    return { priced, coupon: applied, codeStatus: 'none', reason: null, message: null };
  if (!explicit)
    return {
      priced,
      coupon: applied,
      codeStatus: 'rejected',
      reason: 'not_found',
      message: COUPON_MESSAGES.not_found,
    };
  if (applied?.id === explicit.id)
    return { priced, coupon: applied, codeStatus: 'applied', reason: null, message: null };

  const rej = priced.rejected.find((r) => r.couponId === explicit.id);
  const reason = rej?.reason ?? 'no_benefit';
  // El código era válido pero un descuento automático mejor ya está aplicado (no se acumulan).
  if (reason === 'no_benefit' && applied) {
    return {
      priced,
      coupon: applied,
      codeStatus: 'outranked',
      reason,
      message: 'Ya aplicamos un descuento mejor a tu pedido; los descuentos no se acumulan',
    };
  }
  return {
    priced,
    coupon: applied,
    codeStatus: 'rejected',
    reason,
    message: COUPON_MESSAGES[reason],
  };
}

/** En el checkout un código escrito pero inválido es un error explícito (no se ignora en silencio). */
export function assertCodeAccepted(r: DiscountResult): void {
  if (r.codeStatus === 'rejected')
    throw new AuthError(400, 'COUPON_INVALID', r.message ?? 'Cupón inválido');
}

/** Registra el uso del cupón. SOLO se llama cuando el pago se aprueba. Idempotente por (cupón, pedido/inscripción). */
export async function recordRedemption(
  db: Db,
  r: {
    couponId: string;
    orderId?: string;
    enrollmentId?: string;
    email: string;
    discountAmount: number;
  },
): Promise<void> {
  await db
    .insert(couponRedemptions)
    .values({
      couponId: r.couponId,
      orderId: r.orderId ?? null,
      enrollmentId: r.enrollmentId ?? null,
      email: r.email.toLowerCase(),
      discountAmount: r.discountAmount,
    })
    .onConflictDoNothing();
}

export async function redemptionCounts(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: couponRedemptions.couponId, n: sql<number>`count(*)::int` })
    .from(couponRedemptions)
    .where(inArray(couponRedemptions.couponId, ids))
    .groupBy(couponRedemptions.couponId);
  return new Map(rows.map((r) => [r.id, r.n]));
}
