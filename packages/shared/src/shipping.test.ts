import { describe, expect, it } from 'vitest';
import { computeShipping } from './shipping';

const base = {
  subtotal: 100_000,
  hasShippableItems: true,
  flatRate: 12_000,
  freeThreshold: 250_000,
};

describe('computeShipping', () => {
  it('cobra la tarifa fija bajo el umbral', () => expect(computeShipping(base)).toBe(12_000));
  it('es gratis al alcanzar el umbral', () => {
    expect(computeShipping({ ...base, subtotal: 250_000 })).toBe(0);
    expect(computeShipping({ ...base, subtotal: 249_999 })).toBe(12_000);
  });
  it('sin umbral nunca es gratis por monto', () => {
    expect(computeShipping({ ...base, subtotal: 9_999_999, freeThreshold: null })).toBe(12_000);
  });
  it('servicios sin productos físicos no llevan envío', () => {
    expect(computeShipping({ ...base, hasShippableItems: false })).toBe(0);
  });
  it('cupón de envío gratis fuerza 0', () => {
    expect(computeShipping({ ...base, freeShippingCoupon: true })).toBe(0);
  });
});
