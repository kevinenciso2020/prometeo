export const ORDER_STATUSES = [
  'pendiente_pago',
  'pagado',
  'preparando',
  'enviado',
  'entregado',
  'cancelado',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pendiente_pago: 'Pendiente de pago',
  pagado: 'Pagado',
  preparando: 'Preparando',
  enviado: 'Enviado',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

/** Transiciones que puede ejecutar el admin. `pendiente_pago → pagado` solo ocurre por el webhook de Wompi. */
const ADMIN_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pendiente_pago: ['cancelado'],
  pagado: ['preparando', 'cancelado'],
  preparando: ['enviado', 'cancelado'],
  enviado: ['entregado'],
  entregado: [],
  cancelado: [],
};

export function adminOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return ADMIN_TRANSITIONS[from];
}

export function canAdminChangeOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ADMIN_TRANSITIONS[from].includes(to);
}

/** El webhook solo puede confirmar el pago de un pedido pendiente. */
export function canMarkOrderPaid(from: OrderStatus): boolean {
  return from === 'pendiente_pago';
}

/** Pedidos que aún pueden pagarse. */
export function isOrderPayable(status: OrderStatus): boolean {
  return status === 'pendiente_pago';
}
