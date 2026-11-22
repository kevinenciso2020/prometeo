import { CURRENCY } from './constants';

/** Los precios se guardan como enteros en pesos COP (sin decimales). */
export function assertValidCop(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError('El monto debe ser un entero de pesos COP mayor o igual a 0');
  }
  return amount;
}

/** Wompi recibe el monto en centavos. */
export function toWompiCents(amountCop: number): number {
  return assertValidCop(amountCop) * 100;
}

export function formatCop(amountCop: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: CURRENCY,
    maximumFractionDigits: 0,
  }).format(amountCop);
}
