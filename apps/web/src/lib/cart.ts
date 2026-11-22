/**
 * Carrito en localStorage: SOLO ids y cantidades (datos no sensibles).
 * Precio y stock se recalculan siempre en el servidor (/public/cart/quote).
 */
export interface CartItem {
  type: 'product' | 'service';
  id: string;
  quantity: number;
}

const KEY = 'prometeo_cart_v1';
const MAX_QTY = 20;

export function readCart(): CartItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (i): i is CartItem =>
          !!i &&
          typeof i === 'object' &&
          (i.type === 'product' || i.type === 'service') &&
          typeof i.id === 'string' &&
          Number.isInteger(i.quantity) &&
          i.quantity > 0,
      )
      .map((i) => ({ type: i.type, id: i.id, quantity: Math.min(i.quantity, MAX_QTY) }));
  } catch {
    return [];
  }
}

function write(items: CartItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* almacenamiento bloqueado: el carrito simplemente no persiste */
  }
  window.dispatchEvent(new CustomEvent('cart:change', { detail: cartCount(items) }));
}

export function cartCount(items: CartItem[] = readCart()): number {
  return items.reduce((n, i) => n + i.quantity, 0);
}

export function addToCart(item: CartItem): void {
  const items = readCart();
  const found = items.find((i) => i.type === item.type && i.id === item.id);
  if (found) found.quantity = Math.min(found.quantity + item.quantity, MAX_QTY);
  else items.push({ ...item, quantity: Math.min(item.quantity, MAX_QTY) });
  write(items);
}

export function setQuantity(type: CartItem['type'], id: string, quantity: number): void {
  const items = readCart()
    .map((i) =>
      i.type === type && i.id === id ? { ...i, quantity: Math.min(quantity, MAX_QTY) } : i,
    )
    .filter((i) => i.quantity > 0);
  write(items);
}

export function removeFromCart(type: CartItem['type'], id: string): void {
  write(readCart().filter((i) => !(i.type === type && i.id === id)));
}

export function clearCart(): void {
  write([]);
}
