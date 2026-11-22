export interface ShippingInput {
  /** Subtotal en COP (después de descuentos de ítems, antes de envío). */
  subtotal: number;
  /** ¿Hay productos físicos? Los servicios y cursos no llevan envío. */
  hasShippableItems: boolean;
  /** Tarifa fija nacional en COP. */
  flatRate: number;
  /** Envío gratis desde este subtotal; null = sin envío gratis. */
  freeThreshold: number | null;
  /** Un cupón de tipo envío gratis fuerza el envío en 0. */
  freeShippingCoupon?: boolean;
}

export function computeShipping(i: ShippingInput): number {
  if (!i.hasShippableItems || i.freeShippingCoupon) return 0;
  if (i.freeThreshold !== null && i.freeThreshold > 0 && i.subtotal >= i.freeThreshold) return 0;
  return Math.max(0, Math.trunc(i.flatRate));
}
