import { describe, expect, it } from 'vitest';
import {
  campaignMatchesPath,
  campaignSchema,
  couponInputSchema,
  couponSchema,
  ctaUrlSchema,
} from './schemas/marketing';

const base = { type: 'porcentaje', value: 20, code: 'taza20', appliesTo: 'todo' };

describe('esquema de cupones', () => {
  it('normaliza el código a mayúsculas y aplica defaults', () => {
    const r = couponSchema.parse(base);
    expect(r).toMatchObject({
      code: 'TAZA20',
      isAutomatic: false,
      isActive: true,
      minPurchase: 0,
      maxUses: null,
    });
  });
  it('un cupón manual exige código; un automático no puede tenerlo', () => {
    expect(couponSchema.safeParse({ ...base, code: null }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, isAutomatic: true }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, isAutomatic: true, code: null }).success).toBe(true);
  });
  it('valida rangos por tipo', () => {
    expect(couponSchema.safeParse({ ...base, value: 0 }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, value: 101 }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, type: 'monto_fijo', value: 0 }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, type: 'monto_fijo', value: 15000 }).success).toBe(
      true,
    );
    expect(couponSchema.safeParse({ ...base, type: 'envio_gratis', value: 0 }).success).toBe(true);
  });
  it('categorías e ítems exigen objetivos; las fechas deben ser coherentes', () => {
    expect(couponSchema.safeParse({ ...base, appliesTo: 'categorias' }).success).toBe(false);
    expect(
      couponSchema.safeParse({
        ...base,
        appliesTo: 'items',
        targetIds: ['11111111-1111-4111-8111-111111111111'],
      }).success,
    ).toBe(true);
    expect(
      couponSchema.safeParse({
        ...base,
        startsAt: '2030-01-02T00:00:00-05:00',
        endsAt: '2030-01-01T00:00:00-05:00',
      }).success,
    ).toBe(false);
  });
  it('rechaza códigos con caracteres raros', () => {
    expect(couponSchema.safeParse({ ...base, code: 'MI CUPON' }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, code: '<b>' }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, code: 'ab' }).success).toBe(false);
  });
  it('el código que escribe el cliente se normaliza y admite vacío', () => {
    expect(couponInputSchema.parse(' taza20 ')).toBe('TAZA20');
    expect(couponInputSchema.parse('')).toBeNull();
    expect(couponInputSchema.parse(undefined)).toBeNull();
  });
});

describe('esquema de campañas', () => {
  const camp = {
    name: 'Verano',
    placement: 'banner_seccion',
    title: 'Hasta 20%',
    startsAt: '2030-01-01T00:00:00-05:00',
    endsAt: '2030-02-01T00:00:00-05:00',
  };
  it('acepta una campaña válida', () => expect(campaignSchema.safeParse(camp).success).toBe(true));
  it('valida fechas y que el elemento promocionado vaya completo', () => {
    expect(campaignSchema.safeParse({ ...camp, endsAt: camp.startsAt }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...camp, targetType: 'producto' }).success).toBe(false);
    expect(
      campaignSchema.safeParse({
        ...camp,
        targetType: 'producto',
        targetId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
  });
  it('un botón necesita destino; la barra necesita texto', () => {
    expect(campaignSchema.safeParse({ ...camp, ctaText: 'Ver' }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...camp, ctaText: 'Ver', ctaUrl: '/tienda' }).success).toBe(
      true,
    );
    expect(
      campaignSchema.safeParse({ ...camp, placement: 'barra_superior', title: null }).success,
    ).toBe(false);
  });
  it('solo acepta URLs internas o https (bloquea javascript:, data: y protocolo relativo)', () => {
    for (const ok of ['/tienda', '/producto/taza?x=1', 'https://example.com/promo'])
      expect(ctaUrlSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hola',
      '//evil.com',
      'http://example.com',
      'tienda',
      '/\\evil.com',
      'https://',
      ' ',
    ]) {
      expect(ctaUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('segmentación por páginas', () => {
  it('vacío = todas las páginas', () => expect(campaignMatchesPath([], '/cualquiera')).toBe(true));
  it('coincidencia exacta (con o sin barra final y query)', () => {
    expect(campaignMatchesPath(['/tienda'], '/tienda')).toBe(true);
    expect(campaignMatchesPath(['/tienda'], '/tienda/')).toBe(true);
    expect(campaignMatchesPath(['/tienda'], '/tienda?category=tazas')).toBe(true);
    expect(campaignMatchesPath(['/tienda'], '/tienda-vieja')).toBe(false);
    expect(campaignMatchesPath(['/tienda'], '/producto/x')).toBe(false);
  });
  it('comodín final', () => {
    expect(campaignMatchesPath(['/cursos*'], '/cursos')).toBe(true);
    expect(campaignMatchesPath(['/cursos*'], '/cursos/torno')).toBe(true);
    expect(campaignMatchesPath(['/cursos*'], '/tienda')).toBe(false);
    expect(campaignMatchesPath(['/', '/tienda'], '/')).toBe(true);
  });
});
