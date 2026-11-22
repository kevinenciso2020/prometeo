import { describe, expect, it } from 'vitest';
import {
  COUPON_MESSAGES,
  COUPON_SCOPES,
  COUPON_TYPES,
  couponWindowRejection,
  eligibleLines,
  evaluateCoupon,
  linesSubtotal,
  priceOrder,
  type CouponRule,
  type CouponUsage,
  type PricingLine,
} from './pricing';

const NOW = new Date('2026-06-15T15:00:00Z');
const CAT_TAZAS = 'cat-tazas';
const CAT_JARRONES = 'cat-jarrones';

const taza: PricingLine = {
  kind: 'product',
  id: 'p-taza',
  categoryId: CAT_TAZAS,
  unitPrice: 40_000,
  quantity: 2,
}; // 80.000
const jarron: PricingLine = {
  kind: 'product',
  id: 'p-jarron',
  categoryId: CAT_JARRONES,
  unitPrice: 120_000,
  quantity: 1,
}; // 120.000
const taller: PricingLine = { kind: 'service', id: 's-horno', unitPrice: 50_000, quantity: 1 };
const curso: PricingLine = { kind: 'course', id: 'c-torno', unitPrice: 300_000, quantity: 1 };

const rule = (over: Partial<CouponRule> = {}): CouponRule => ({
  id: 'k1',
  code: 'PROMO',
  type: 'porcentaje',
  value: 10,
  appliesTo: 'todo',
  targetIds: [],
  minPurchase: 0,
  startsAt: null,
  endsAt: null,
  maxUses: null,
  maxUsesPerEmail: null,
  isAutomatic: false,
  isActive: true,
  ...over,
});
const fresh: CouponUsage = { total: 0, byEmail: 0 };
const ctx = (usage: CouponUsage = fresh) => ({ now: NOW, usage });
const shipping = { flatRate: 12_000, freeThreshold: 250_000 as number | null };
const price = (
  lines: PricingLine[],
  coupons: { rule: CouponRule; usage?: CouponUsage }[] = [],
  ship = shipping,
) =>
  priceOrder({
    lines,
    shipping: ship,
    now: NOW,
    coupons: coupons.map((c) => ({ rule: c.rule, usage: c.usage ?? fresh })),
  });

describe('subtotales y alcance (appliesTo)', () => {
  it('suma precio x cantidad', () => expect(linesSubtotal([taza, jarron, taller])).toBe(250_000));

  it('todo: incluye productos, servicios y cursos', () => {
    expect(eligibleLines(rule({ appliesTo: 'todo' }), [taza, taller, curso])).toHaveLength(3);
  });
  it('productos: solo productos', () => {
    expect(
      eligibleLines(rule({ appliesTo: 'productos' }), [taza, taller, curso]).map((l) => l.id),
    ).toEqual(['p-taza']);
  });
  it('cursos: solo cursos', () => {
    expect(
      eligibleLines(rule({ appliesTo: 'cursos' }), [taza, taller, curso]).map((l) => l.id),
    ).toEqual(['c-torno']);
  });
  it('categorias: solo productos de esas categorías (no servicios ni cursos)', () => {
    const r = rule({ appliesTo: 'categorias', targetIds: [CAT_TAZAS] });
    expect(eligibleLines(r, [taza, jarron, taller, curso]).map((l) => l.id)).toEqual(['p-taza']);
    expect(eligibleLines(r, [{ ...taza, categoryId: null }])).toEqual([]);
  });
  it('items: por id exacto, de cualquier tipo', () => {
    const r = rule({ appliesTo: 'items', targetIds: ['p-jarron', 'c-torno'] });
    expect(eligibleLines(r, [taza, jarron, taller, curso]).map((l) => l.id)).toEqual([
      'p-jarron',
      'c-torno',
    ]);
  });
  it('cubre todos los alcances declarados', () => expect(COUPON_SCOPES).toHaveLength(5));
});

describe('vigencia [inicio, fin)', () => {
  it('inactivo', () =>
    expect(couponWindowRejection(rule({ isActive: false }), NOW)).toBe('inactive'));
  it('aún no inicia', () =>
    expect(couponWindowRejection(rule({ startsAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(
      'not_started',
    ));
  it('inicia exactamente ahora: vigente', () =>
    expect(couponWindowRejection(rule({ startsAt: NOW }), NOW)).toBeNull());
  it('termina exactamente ahora: vencido (fin exclusivo)', () =>
    expect(couponWindowRejection(rule({ endsAt: NOW }), NOW)).toBe('expired'));
  it('termina un ms después: vigente', () =>
    expect(couponWindowRejection(rule({ endsAt: new Date(NOW.getTime() + 1) }), NOW)).toBeNull());
  it('sin fechas: siempre vigente', () => expect(couponWindowRejection(rule(), NOW)).toBeNull());
  it('inactivo gana sobre vencido', () => {
    expect(couponWindowRejection(rule({ isActive: false, endsAt: new Date(0) }), NOW)).toBe(
      'inactive',
    );
  });
});

describe('evaluateCoupon: tipos de descuento', () => {
  it('porcentaje sobre el subtotal elegible', () => {
    expect(evaluateCoupon(rule({ value: 20 }), [taza, jarron], ctx())).toEqual({
      ok: true,
      itemDiscount: 40_000,
      freeShipping: false,
    });
  });
  it('porcentaje solo sobre lo elegible (categoría tazas)', () => {
    const r = rule({ value: 20, appliesTo: 'categorias', targetIds: [CAT_TAZAS] });
    expect(evaluateCoupon(r, [taza, jarron], ctx())).toMatchObject({
      ok: true,
      itemDiscount: 16_000,
    });
  });
  it('porcentaje redondea al peso más cercano (mitad hacia arriba)', () => {
    const l: PricingLine = { kind: 'product', id: 'x', unitPrice: 1_001, quantity: 1 };
    expect(evaluateCoupon(rule({ value: 50 }), [l], ctx())).toMatchObject({ itemDiscount: 501 }); // 500,5 -> 501
    expect(evaluateCoupon(rule({ value: 33 }), [{ ...l, unitPrice: 1_000 }], ctx())).toMatchObject({
      itemDiscount: 330,
    });
    expect(evaluateCoupon(rule({ value: 15 }), [{ ...l, unitPrice: 999 }], ctx())).toMatchObject({
      itemDiscount: 150,
    }); // 149,85
  });
  it('100% descuenta todo lo elegible', () => {
    expect(evaluateCoupon(rule({ value: 100 }), [taza], ctx())).toMatchObject({
      itemDiscount: 80_000,
    });
  });
  it('monto fijo', () => {
    expect(
      evaluateCoupon(rule({ type: 'monto_fijo', value: 25_000 }), [taza, jarron], ctx()),
    ).toMatchObject({ ok: true, itemDiscount: 25_000, freeShipping: false });
  });
  it('monto fijo nunca supera el subtotal elegible', () => {
    expect(
      evaluateCoupon(rule({ type: 'monto_fijo', value: 500_000 }), [taza], ctx()),
    ).toMatchObject({ itemDiscount: 80_000 });
    const r = rule({
      type: 'monto_fijo',
      value: 100_000,
      appliesTo: 'categorias',
      targetIds: [CAT_TAZAS],
    });
    expect(evaluateCoupon(r, [taza, jarron], ctx())).toMatchObject({ itemDiscount: 80_000 });
  });
  it('envío gratis: sin descuento en ítems y con bandera', () => {
    expect(evaluateCoupon(rule({ type: 'envio_gratis', value: 0 }), [taza], ctx())).toEqual({
      ok: true,
      itemDiscount: 0,
      freeShipping: true,
    });
  });
  it('cubre todos los tipos declarados', () => expect(COUPON_TYPES).toHaveLength(3));
});

describe('evaluateCoupon: límites y condiciones', () => {
  it('rechaza si no aplica a ningún ítem', () => {
    expect(evaluateCoupon(rule({ appliesTo: 'cursos' }), [taza], ctx())).toEqual({
      ok: false,
      reason: 'not_applicable',
    });
    expect(evaluateCoupon(rule(), [], ctx())).toEqual({ ok: false, reason: 'not_applicable' });
  });
  it('compra mínima: borde exacto cumple, un peso menos no', () => {
    expect(evaluateCoupon(rule({ minPurchase: 80_000 }), [taza], ctx())).toMatchObject({
      ok: true,
    });
    expect(evaluateCoupon(rule({ minPurchase: 80_001 }), [taza], ctx())).toEqual({
      ok: false,
      reason: 'min_purchase',
    });
  });
  it('compra mínima se mide sobre lo ELEGIBLE, no sobre todo el carrito', () => {
    const r = rule({ appliesTo: 'categorias', targetIds: [CAT_TAZAS], minPurchase: 100_000 });
    expect(evaluateCoupon(r, [taza, jarron], ctx())).toEqual({ ok: false, reason: 'min_purchase' }); // tazas 80.000 < 100.000
  });
  it('usos máximos totales: borde', () => {
    expect(
      evaluateCoupon(rule({ maxUses: 5 }), [taza], ctx({ total: 4, byEmail: 0 })),
    ).toMatchObject({ ok: true });
    expect(evaluateCoupon(rule({ maxUses: 5 }), [taza], ctx({ total: 5, byEmail: 0 }))).toEqual({
      ok: false,
      reason: 'max_uses',
    });
    expect(evaluateCoupon(rule({ maxUses: 0 }), [taza], ctx())).toEqual({
      ok: false,
      reason: 'max_uses',
    });
  });
  it('usos por correo: borde', () => {
    expect(
      evaluateCoupon(rule({ maxUsesPerEmail: 1 }), [taza], ctx({ total: 9, byEmail: 0 })),
    ).toMatchObject({ ok: true });
    expect(
      evaluateCoupon(rule({ maxUsesPerEmail: 1 }), [taza], ctx({ total: 9, byEmail: 1 })),
    ).toEqual({ ok: false, reason: 'max_uses_email' });
  });
  it('sin correo conocido (vista previa) no se aplica el límite por correo', () => {
    expect(
      evaluateCoupon(rule({ maxUsesPerEmail: 1 }), [taza], ctx({ total: 0, byEmail: null })),
    ).toMatchObject({ ok: true });
  });
  it('sin límites: nulos significan ilimitado', () => {
    expect(
      evaluateCoupon(
        rule({ maxUses: null, maxUsesPerEmail: null }),
        [taza],
        ctx({ total: 99_999, byEmail: 99_999 }),
      ),
    ).toMatchObject({ ok: true });
  });
  it('orden de validación: vigencia antes que usos antes que alcance antes que mínimo', () => {
    const base = rule({ isActive: false, maxUses: 1, appliesTo: 'cursos', minPurchase: 9e9 });
    expect(evaluateCoupon(base, [taza], ctx({ total: 5, byEmail: 5 }))).toEqual({
      ok: false,
      reason: 'inactive',
    });
    expect(
      evaluateCoupon({ ...base, isActive: true }, [taza], ctx({ total: 5, byEmail: 5 })),
    ).toEqual({ ok: false, reason: 'max_uses' });
    expect(evaluateCoupon({ ...base, isActive: true }, [taza], ctx())).toEqual({
      ok: false,
      reason: 'not_applicable',
    });
  });
  it('todos los motivos de rechazo tienen mensaje en español', () => {
    for (const msg of Object.values(COUPON_MESSAGES)) expect(msg.length).toBeGreaterThan(10);
  });
});

describe('priceOrder: totales y envío', () => {
  it('sin cupones: subtotal + envío', () => {
    expect(price([taza])).toMatchObject({
      subtotal: 80_000,
      itemDiscount: 0,
      baseShipping: 12_000,
      shipping: 12_000,
      total: 92_000,
      applied: null,
    });
  });
  it('porcentaje aplicado: total = subtotal - descuento + envío', () => {
    const r = price([taza, jarron], [{ rule: rule({ value: 10 }) }]);
    expect(r).toMatchObject({
      subtotal: 200_000,
      itemDiscount: 20_000,
      shipping: 12_000,
      total: 192_000,
    });
    expect(r.applied).toMatchObject({
      couponId: 'k1',
      code: 'PROMO',
      type: 'porcentaje',
      itemDiscount: 20_000,
      shippingSaved: 0,
    });
  });
  it('envío gratis por umbral se evalúa DESPUÉS del descuento', () => {
    // 260.000 supera 250.000 (gratis) pero con 10% queda en 234.000 -> se cobra envío
    const l: PricingLine = { kind: 'product', id: 'x', unitPrice: 260_000, quantity: 1 };
    expect(price([l]).shipping).toBe(0);
    expect(price([l], [{ rule: rule({ value: 10 }) }])).toMatchObject({
      itemDiscount: 26_000,
      shipping: 12_000,
      total: 246_000,
    });
  });
  it('cupón de envío gratis: ahorra el envío y reporta shippingSaved', () => {
    const r = price([taza], [{ rule: rule({ type: 'envio_gratis', value: 0 }) }]);
    expect(r).toMatchObject({ itemDiscount: 0, baseShipping: 12_000, shipping: 0, total: 80_000 });
    expect(r.applied).toMatchObject({ type: 'envio_gratis', shippingSaved: 12_000 });
  });
  it('envío gratis cuando ya era gratis: sin beneficio (rechazado)', () => {
    const r = price(
      [jarron, taza, taller, { ...jarron, id: 'j2' }],
      [{ rule: rule({ type: 'envio_gratis', value: 0 }) }],
    );
    expect(r.applied).toBeNull();
    expect(r.rejected).toEqual([{ couponId: 'k1', code: 'PROMO', reason: 'no_benefit' }]);
  });
  it('solo servicios/cursos: no hay envío ni que ahorrar', () => {
    expect(price([taller, curso])).toMatchObject({ baseShipping: 0, shipping: 0, total: 350_000 });
    expect(price([curso], [{ rule: rule({ type: 'envio_gratis', value: 0 }) }]).applied).toBeNull();
  });
  it('sin umbral configurado nunca hay envío gratis por monto', () => {
    expect(
      price([{ ...jarron, unitPrice: 9_000_000 }], [], { flatRate: 12_000, freeThreshold: null })
        .shipping,
    ).toBe(12_000);
  });
  it('un cupón en categoría que no está en el carrito se rechaza y no altera el total', () => {
    const r = price(
      [jarron],
      [{ rule: rule({ appliesTo: 'categorias', targetIds: [CAT_TAZAS] }) }],
    );
    expect(r.applied).toBeNull();
    expect(r.rejected[0]?.reason).toBe('not_applicable');
    expect(r.total).toBe(132_000);
  });
  it('un cupón que dejaría el total en cero se rechaza (total_zero)', () => {
    expect(price([curso], [{ rule: rule({ value: 100 }) }])).toMatchObject({
      applied: null,
      total: 300_000,
    });
    expect(price([curso], [{ rule: rule({ value: 100 }) }]).rejected[0]?.reason).toBe('total_zero');
    expect(
      price([curso], [{ rule: rule({ type: 'monto_fijo', value: 300_000 }) }]).rejected[0]?.reason,
    ).toBe('total_zero');
    expect(price([curso], [{ rule: rule({ type: 'monto_fijo', value: 299_999 }) }]).total).toBe(1);
  });
  it('100% en productos con envío cobra solo el envío', () => {
    expect(price([taza], [{ rule: rule({ value: 100 }) }])).toMatchObject({
      itemDiscount: 80_000,
      shipping: 12_000,
      total: 12_000,
    });
  });
});

describe('priceOrder: selección entre cupón y descuentos automáticos (no se acumulan)', () => {
  const auto = (over: Partial<CouponRule> = {}) =>
    rule({ id: 'auto1', code: null, isAutomatic: true, ...over });

  it('gana el que más beneficia', () => {
    const r = price(
      [taza, jarron],
      [{ rule: rule({ id: 'code', value: 10 }) }, { rule: auto({ value: 25 }) }],
    );
    expect(r.applied?.couponId).toBe('auto1');
    expect(r.itemDiscount).toBe(50_000);
  });
  it('NO se acumulan: solo se aplica uno', () => {
    const r = price(
      [taza, jarron],
      [{ rule: rule({ id: 'code', value: 10 }) }, { rule: auto({ value: 10 }) }],
    );
    expect(r.itemDiscount).toBe(20_000);
    expect(r.rejected.filter((x) => x.reason === 'no_benefit')).toHaveLength(1);
  });
  it('en empate gana el cupón con código sobre el automático', () => {
    const r = price(
      [taza, jarron],
      [{ rule: auto({ value: 10 }) }, { rule: rule({ id: 'zzz', value: 10 }) }],
    );
    expect(r.applied).toMatchObject({ couponId: 'zzz', isAutomatic: false });
  });
  it('el beneficio incluye el ahorro de envío', () => {
    // 5.000 fijo + (no envío) vs envío gratis (12.000): gana el envío gratis
    const r = price(
      [taza],
      [
        { rule: rule({ id: 'a', type: 'monto_fijo', value: 5_000 }) },
        { rule: rule({ id: 'b', type: 'envio_gratis', value: 0 }) },
      ],
    );
    expect(r.applied?.couponId).toBe('b');
    const r2 = price(
      [taza],
      [
        { rule: rule({ id: 'a', type: 'monto_fijo', value: 20_000 }) },
        { rule: rule({ id: 'b', type: 'envio_gratis', value: 0 }) },
      ],
    );
    expect(r2.applied?.couponId).toBe('a');
  });
  it('el resultado no depende del orden de entrada', () => {
    const cs = [
      { rule: rule({ id: 'a', value: 10 }) },
      { rule: auto({ id: 'b', value: 10 }) },
      { rule: rule({ id: 'c', value: 5 }) },
    ];
    const a = price([taza, jarron], cs);
    const b = price([taza, jarron], [...cs].reverse());
    expect(a.applied).toEqual(b.applied);
    expect(a.total).toBe(b.total);
  });
  it('un candidato inválido no impide aplicar otro válido', () => {
    const r = price(
      [taza],
      [
        { rule: rule({ id: 'vencido', endsAt: new Date(0), value: 90 }) },
        { rule: auto({ value: 10 }) },
      ],
    );
    expect(r.applied?.couponId).toBe('auto1');
    expect(r.rejected).toContainEqual({ couponId: 'vencido', code: 'PROMO', reason: 'expired' });
  });
  it('todos inválidos: precio sin descuento y motivos informados', () => {
    const r = price([taza], [{ rule: rule({ isActive: false }) }]);
    expect(r).toMatchObject({ applied: null, itemDiscount: 0, total: 92_000 });
    expect(r.rejected).toEqual([{ couponId: 'k1', code: 'PROMO', reason: 'inactive' }]);
  });
  it('respeta el uso acumulado de cada candidato', () => {
    const r = price([taza], [{ rule: rule({ maxUses: 1 }), usage: { total: 1, byEmail: 0 } }]);
    expect(r.rejected[0]?.reason).toBe('max_uses');
  });
});

describe('priceOrder: propiedades (valores pseudoaleatorios deterministas)', () => {
  let seed = 123_456_789;
  const rnd = () => (seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296;
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  it('en 3.000 casos: total >= 1, descuento <= subtotal, total = subtotal - descuento + envío, determinista', () => {
    for (let i = 0; i < 3_000; i++) {
      const lines: PricingLine[] = Array.from({ length: int(1, 4) }, (_, k) => ({
        kind: (['product', 'service', 'course'] as const)[int(0, 2)] as PricingLine['kind'],
        id: `i${k}`,
        categoryId: rnd() < 0.5 ? CAT_TAZAS : CAT_JARRONES,
        unitPrice: int(1, 400_000),
        quantity: int(1, 5),
      }));
      const types = ['porcentaje', 'monto_fijo', 'envio_gratis'] as const;
      const scopes = ['todo', 'productos', 'cursos', 'categorias', 'items'] as const;
      const coupons = Array.from({ length: int(0, 3) }, (_, k) => ({
        rule: rule({
          id: `k${k}`,
          type: types[int(0, 2)] as CouponRule['type'],
          value: int(0, 120),
          appliesTo: scopes[int(0, 4)] as CouponRule['appliesTo'],
          targetIds: [CAT_TAZAS, 'i0'],
          minPurchase: int(0, 300_000),
          isAutomatic: rnd() < 0.5,
        }),
        usage: fresh,
      }));
      const ship = {
        flatRate: int(0, 30_000),
        freeThreshold: rnd() < 0.5 ? int(1, 800_000) : null,
      };
      const r1 = priceOrder({ lines, shipping: ship, now: NOW, coupons });
      const r2 = priceOrder({ lines, shipping: ship, now: NOW, coupons });
      expect(r1).toEqual(r2);
      const sub = linesSubtotal(lines);
      expect(r1.subtotal).toBe(sub);
      expect(r1.itemDiscount).toBeGreaterThanOrEqual(0);
      expect(r1.itemDiscount).toBeLessThanOrEqual(sub);
      expect(r1.total).toBe(r1.subtotal - r1.itemDiscount + r1.shipping);
      expect(r1.total).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(r1.total)).toBe(true);
      expect(r1.shipping).toBeGreaterThanOrEqual(0);
      // Aplicar un cupón nunca encarece el pedido
      expect(r1.total).toBeLessThanOrEqual(sub + r1.baseShipping);
    }
  });
});
