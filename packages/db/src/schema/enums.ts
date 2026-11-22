import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['CLIENTE', 'ADMIN', 'SUPER_ADMIN']);
export const authTokenTypeEnum = pgEnum('auth_token_type', ['verify_email', 'reset_password']);
export const contentStatusEnum = pgEnum('content_status', ['borrador', 'publicado', 'archivado']);
export const serviceModeEnum = pgEnum('service_mode', ['pago_online', 'cotizacion']);
export const quoteStatusEnum = pgEnum('quote_status', ['nueva', 'contactada', 'cerrada']);
export const editionStatusEnum = pgEnum('edition_status', [
  'abierta',
  'llena',
  'cerrada',
  'finalizada',
  'cancelada',
]);
export const paymentModeEnum = pgEnum('payment_mode', ['total', 'reserva', 'abono', 'lista']);
export const depositTypeEnum = pgEnum('deposit_type', ['monto', 'porcentaje']);
export const enrollmentStatusEnum = pgEnum('enrollment_status', [
  'lista',
  'reservada',
  'abonada',
  'pagada',
  'vencida',
  'cancelada',
]);
export const orderStatusEnum = pgEnum('order_status', [
  'pendiente_pago',
  'pagado',
  'preparando',
  'enviado',
  'entregado',
  'cancelado',
]);
export const orderItemTypeEnum = pgEnum('order_item_type', ['product', 'service']);
export const paymentKindEnum = pgEnum('payment_kind', ['order', 'enrollment']);
export const paymentPurposeEnum = pgEnum('payment_purpose', ['total', 'reserva', 'abono', 'saldo']);
export const paymentMethodEnum = pgEnum('payment_method', ['wompi', 'efectivo', 'transferencia']);
export const paymentStatusEnum = pgEnum('payment_status', [
  'pendiente',
  'aprobado',
  'rechazado',
  'error',
  'anulado',
]);
export const couponTypeEnum = pgEnum('coupon_type', ['porcentaje', 'monto_fijo', 'envio_gratis']);
export const couponScopeEnum = pgEnum('coupon_scope', [
  'todo',
  'productos',
  'cursos',
  'categorias',
  'items',
]);
export const campaignPlacementEnum = pgEnum('campaign_placement', [
  'hero_banner',
  'banner_seccion',
  'popup',
  'barra_superior',
]);
export const campaignTargetEnum = pgEnum('campaign_target', [
  'producto',
  'curso',
  'edicion',
  'categoria',
]);
export const campaignEventTypeEnum = pgEnum('campaign_event_type', ['impression', 'click']);
export const guestSubjectEnum = pgEnum('guest_subject', ['order', 'enrollment']);
