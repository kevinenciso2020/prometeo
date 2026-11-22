/**
 * Motor de precios y descuentos (lógica PURA, sin I/O).
 * Todo cálculo de descuentos ocurre en el servidor con esta función; el navegador solo muestra el resultado.
 *
 * Reglas (documentadas aquí para que coincidan con los tests):
 *  - Los montos son enteros en pesos COP. El porcentaje se redondea al peso más cercano (mitades hacia arriba).
 *  - "Compra mínima" se compara con el subtotal de los ítems ELEGIBLES para el cupón (no con todo el carrito).
 *  - Un descuento nunca supera el subtotal elegible y el total a pagar nunca baja de $1.
 *  - NO se acumulan descuentos: se aplica un solo cupón, el que más beneficia al cliente
 *    (descuento en ítems + ahorro de envío). En empate gana el cupón con código sobre el automático.
 *  - El envío gratis por umbral se evalúa sobre el subtotal DESPUÉS de descuentos.
 */
import { computeShipping } from './shipping';

export type LineKind = 'product' | 'service' | 'course';

export interface PricingLine {
  kind: LineKind;
  /** Id del producto, servicio o curso. */
  id: string;
  /** Categoría del producto (para cupones por categoría). */
  categoryId?: string | null;
  unitPrice: number;
  quantity: number;
}

export const COUPON_TYPES = ['porcentaje', 'monto_fijo', 'envio_gratis'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];
export const COUPON_SCOPES = ['todo', 'productos', 'cursos', 'categorias', 'items'] as const;
export type CouponScope = (typeof COUPON_SCOPES)[number];

export interface CouponRule {
  id: string;
  /** null en los descuentos automáticos. */
  code: string | null;
  type: CouponType;
  value: number;
  appliesTo: CouponScope;
  targetIds: readonly string[];
  minPurchase: number;
  startsAt: Date | null;
  endsAt: Date | null;
  maxUses: number | null;
  maxUsesPerEmail: number | null;
  isAutomatic: boolean;
  isActive: boolean;
}

export interface CouponUsage {
  /** Usos aprobados totales. */
  total: number;
  /** Usos aprobados por este correo; null si aún no se conoce el correo (vista previa del carrito). */
  byEmail: number | null;
}

export type CouponRejection =
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'max_uses'
  | 'max_uses_email'
  | 'min_purchase'
  | 'not_applicable'
  | 'no_benefit'
  | 'total_zero'
  | 'not_found';

export const COUPON_MESSAGES: Record<CouponRejection, string> = {
  not_found: 'El código no existe',
  inactive: 'Este cupón no está activo',
  not_started: 'Este cupón aún no está vigente',
  expired: 'Este cupón ya venció',
  max_uses: 'Este cupón alcanzó su límite de usos',
  max_uses_email: 'Ya usaste este cupón el máximo de veces permitido',
  min_purchase: 'Tu compra no alcanza el mínimo para este cupón',
  not_applicable: 'Este cupón no aplica a los productos de tu carrito',
  no_benefit: 'Este cupón no genera un descuento en tu carrito',
  total_zero: 'El descuento no puede dejar el total en cero',
};

export function lineTotal(l: PricingLine): number {
  return l.unitPrice * l.quantity;
}

export function linesSubtotal(lines: readonly PricingLine[]): number {
  return lines.reduce((n, l) => n + lineTotal(l), 0);
}

/** Ítems del carrito a los que aplica el cupón. */
export function eligibleLines(
  rule: Pick<CouponRule, 'appliesTo' | 'targetIds'>,
  lines: readonly PricingLine[],
): PricingLine[] {
  switch (rule.appliesTo) {
    case 'todo':
      return [...lines];
    case 'productos':
      return lines.filter((l) => l.kind === 'product');
    case 'cursos':
      return lines.filter((l) => l.kind === 'course');
    case 'categorias':
      return lines.filter(
        (l) =>
          l.kind === 'product' && l.categoryId != null && rule.targetIds.includes(l.categoryId),
      );
    case 'items':
      return lines.filter((l) => rule.targetIds.includes(l.id));
  }
}

/** Vigencia: [startsAt, endsAt). */
export function couponWindowRejection(
  rule: Pick<CouponRule, 'isActive' | 'startsAt' | 'endsAt'>,
  now: Date,
): CouponRejection | null {
  if (!rule.isActive) return 'inactive';
  if (rule.startsAt && now.getTime() < rule.startsAt.getTime()) return 'not_started';
  if (rule.endsAt && now.getTime() >= rule.endsAt.getTime()) return 'expired';
  return null;
}

export type CouponEvaluation =
  | { ok: true; itemDiscount: number; freeShipping: boolean }
  | { ok: false; reason: CouponRejection };

export function evaluateCoupon(
  rule: CouponRule,
  lines: readonly PricingLine[],
  ctx: { now: Date; usage: CouponUsage },
): CouponEvaluation {
  const window = couponWindowRejection(rule, ctx.now);
  if (window) return { ok: false, reason: window };
  if (rule.maxUses !== null && ctx.usage.total >= rule.maxUses)
    return { ok: false, reason: 'max_uses' };
  if (
    rule.maxUsesPerEmail !== null &&
    ctx.usage.byEmail !== null &&
    ctx.usage.byEmail >= rule.maxUsesPerEmail
  ) {
    return { ok: false, reason: 'max_uses_email' };
  }
  const eligible = eligibleLines(rule, lines);
  if (eligible.length === 0) return { ok: false, reason: 'not_applicable' };
  const eligibleSubtotal = linesSubtotal(eligible);
  if (eligibleSubtotal < rule.minPurchase) return { ok: false, reason: 'min_purchase' };

  let itemDiscount = 0;
  if (rule.type === 'porcentaje') itemDiscount = Math.round((eligibleSubtotal * rule.value) / 100);
  else if (rule.type === 'monto_fijo') itemDiscount = rule.value;
  itemDiscount = Math.max(0, Math.min(itemDiscount, eligibleSubtotal));
  return { ok: true, itemDiscount, freeShipping: rule.type === 'envio_gratis' };
}

export interface ShippingConfig {
  flatRate: number;
  freeThreshold: number | null;
}

export interface PricingInput {
  lines: readonly PricingLine[];
  shipping: ShippingConfig;
  now: Date;
  /** Cupón escrito por el cliente y descuentos automáticos vigentes, con su uso acumulado. */
  coupons: readonly { rule: CouponRule; usage: CouponUsage }[];
}

export interface AppliedCoupon {
  couponId: string;
  code: string | null;
  type: CouponType;
  isAutomatic: boolean;
  itemDiscount: number;
  /** Ahorro en envío frente al envío que se habría cobrado sin el cupón (puede ser 0). */
  shippingSaved: number;
}

export interface PricedOrder {
  subtotal: number;
  itemDiscount: number;
  /** Envío sin ningún cupón. */
  baseShipping: number;
  /** Envío final a cobrar. */
  shipping: number;
  total: number;
  applied: AppliedCoupon | null;
  rejected: { couponId: string; code: string | null; reason: CouponRejection }[];
}

export function priceOrder(input: PricingInput): PricedOrder {
  const { lines, shipping: cfg, now } = input;
  const subtotal = linesSubtotal(lines);
  const hasShippable = lines.some((l) => l.kind === 'product');
  const shippingFor = (sub: number, freeCoupon = false) =>
    computeShipping({
      subtotal: sub,
      hasShippableItems: hasShippable,
      flatRate: cfg.flatRate,
      freeThreshold: cfg.freeThreshold,
      freeShippingCoupon: freeCoupon,
    });

  const baseShipping = shippingFor(subtotal);
  const baseTotal = subtotal + baseShipping;
  const rejected: PricedOrder['rejected'] = [];
  const options: {
    rule: CouponRule;
    itemDiscount: number;
    shipping: number;
    total: number;
    benefit: number;
  }[] = [];

  for (const { rule, usage } of input.coupons) {
    const ev = evaluateCoupon(rule, lines, { now, usage });
    if (!ev.ok) {
      rejected.push({ couponId: rule.id, code: rule.code, reason: ev.reason });
      continue;
    }
    const shipping = shippingFor(subtotal - ev.itemDiscount, ev.freeShipping);
    const total = subtotal - ev.itemDiscount + shipping;
    if (total < 1) {
      rejected.push({ couponId: rule.id, code: rule.code, reason: 'total_zero' });
      continue;
    }
    const benefit = baseTotal - total;
    if (benefit <= 0) {
      rejected.push({ couponId: rule.id, code: rule.code, reason: 'no_benefit' });
      continue;
    }
    options.push({ rule, itemDiscount: ev.itemDiscount, shipping, total, benefit });
  }

  options.sort(
    (a, b) =>
      b.benefit - a.benefit ||
      Number(a.rule.isAutomatic) - Number(b.rule.isAutomatic) || // con código antes que automático
      a.rule.id.localeCompare(b.rule.id),
  );
  const best = options[0];
  // Los perdedores válidos también se reportan como no aplicados (no se acumulan).
  const rest = options
    .slice(1)
    .map((o) => ({ couponId: o.rule.id, code: o.rule.code, reason: 'no_benefit' as const }));

  if (!best) {
    return {
      subtotal,
      itemDiscount: 0,
      baseShipping,
      shipping: baseShipping,
      total: baseTotal,
      applied: null,
      rejected,
    };
  }
  return {
    subtotal,
    itemDiscount: best.itemDiscount,
    baseShipping,
    shipping: best.shipping,
    total: best.total,
    applied: {
      couponId: best.rule.id,
      code: best.rule.code,
      type: best.rule.type,
      isAutomatic: best.rule.isAutomatic,
      itemDiscount: best.itemDiscount,
      shippingSaved: Math.max(0, baseShipping - best.shipping),
    },
    rejected: [...rejected, ...rest],
  };
}
