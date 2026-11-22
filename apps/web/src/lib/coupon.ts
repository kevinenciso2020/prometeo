/** Código de cupón elegido por el cliente (dato no sensible). El descuento SIEMPRE lo calcula el servidor. */
const KEY = 'prometeo_coupon_v1';

export function getCoupon(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCoupon(code: string | null): void {
  try {
    if (code) localStorage.setItem(KEY, code.trim().toUpperCase());
    else localStorage.removeItem(KEY);
  } catch {
    /* almacenamiento bloqueado: el cupón no persiste */
  }
}

export interface CouponInfo {
  applied: {
    code: string | null;
    isAutomatic: boolean;
    itemDiscount: number;
    shippingSaved: number;
  } | null;
  status: 'none' | 'applied' | 'outranked' | 'rejected';
  message: string | null;
}

/** Texto para el cliente según el resultado del servidor. */
export function couponText(c: CouponInfo): { text: string; tone: 'ok' | 'error' | 'info' } {
  if (c.status === 'rejected') return { text: c.message ?? 'Cupón inválido', tone: 'error' };
  if (c.status === 'outranked') return { text: c.message ?? '', tone: 'info' };
  if (c.applied?.isAutomatic) return { text: 'Descuento automático aplicado', tone: 'ok' };
  if (c.applied) return { text: `Cupón ${c.applied.code ?? ''} aplicado`, tone: 'ok' };
  return { text: '', tone: 'info' };
}
