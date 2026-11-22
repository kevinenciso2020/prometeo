/**
 * Máquina de estados de inscripciones y reglas de cupos/abonos.
 * Lógica pura (sin I/O) para poder probarla de forma exhaustiva.
 */
export const ENROLLMENT_STATES = [
  'lista',
  'reservada',
  'abonada',
  'pagada',
  'vencida',
  'cancelada',
] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

export const PAYMENT_MODES = ['total', 'reserva', 'abono', 'lista'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  total: 'Pago total ahora',
  reserva: 'Reservar y pagar después',
  abono: 'Abono + saldo',
  lista: 'Lista sin reserva',
};

/** Estados que OCUPAN cupo. `lista` no ocupa. */
export const SEAT_STATES: readonly EnrollmentState[] = ['reservada', 'abonada', 'pagada'];
/** Estados "vivos": impiden inscribirse dos veces en la misma edición. */
export const ACTIVE_STATES: readonly EnrollmentState[] = [
  'lista',
  'reservada',
  'abonada',
  'pagada',
];

export type EnrollmentEvent = 'reserve' | 'pay_partial' | 'pay_full' | 'expire' | 'cancel';

const TRANSITIONS: Record<EnrollmentState, Partial<Record<EnrollmentEvent, EnrollmentState>>> = {
  lista: { reserve: 'reservada', pay_partial: 'abonada', pay_full: 'pagada', cancel: 'cancelada' },
  reservada: { pay_partial: 'abonada', pay_full: 'pagada', expire: 'vencida', cancel: 'cancelada' },
  abonada: { pay_partial: 'abonada', pay_full: 'pagada', cancel: 'cancelada' },
  pagada: { cancel: 'cancelada' },
  vencida: {},
  cancelada: {},
};

export function transition(state: EnrollmentState, event: EnrollmentEvent): EnrollmentState | null {
  return TRANSITIONS[state][event] ?? null;
}

export function canTransition(state: EnrollmentState, event: EnrollmentEvent): boolean {
  return transition(state, event) !== null;
}

export function occupiesSeat(state: EnrollmentState): boolean {
  return SEAT_STATES.includes(state);
}

/** Cambio neto de cupos ocupados al pasar de un estado a otro (-1, 0 o +1). */
export function seatDelta(from: EnrollmentState, to: EnrollmentState): -1 | 0 | 1 {
  return (Number(occupiesSeat(to)) - Number(occupiesSeat(from))) as -1 | 0 | 1;
}

export function isTerminal(state: EnrollmentState): boolean {
  return Object.keys(TRANSITIONS[state]).length === 0;
}

/** Evento que corresponde a un pago acumulado `paid` sobre un total. */
export function eventForPayment(paidAfter: number, total: number): 'pay_partial' | 'pay_full' {
  return paidAfter >= total ? 'pay_full' : 'pay_partial';
}

/** Monto del abono según la configuración de la edición. Siempre entre 1 y el precio. */
export function computeDeposit(price: number, type: 'monto' | 'porcentaje', value: number): number {
  if (price <= 0) return 0;
  const raw = type === 'porcentaje' ? Math.ceil((price * value) / 100) : value;
  return Math.min(price, Math.max(1, Math.trunc(raw)));
}

/** Tiempo que se retiene el cupo mientras la persona paga ahora (total/abono). */
export const PAYMENT_HOLD_MINUTES = 60;

/**
 * Hasta cuándo queda retenido el cupo. La reserva nunca supera la fecha límite de inscripción.
 * `lista` no retiene cupo (null).
 */
export function computeReservedUntil(
  now: Date,
  mode: PaymentMode,
  reservationHours: number,
  enrollmentDeadline: Date,
): Date | null {
  if (mode === 'lista') return null;
  const ms = mode === 'reserva' ? reservationHours * 3_600_000 : PAYMENT_HOLD_MINUTES * 60_000;
  return new Date(Math.min(now.getTime() + ms, enrollmentDeadline.getTime()));
}

export type EditionStatus = 'abierta' | 'llena' | 'cerrada' | 'finalizada' | 'cancelada';

/** ¿Se aceptan nuevas inscripciones en esta edición? */
export function isEditionOpen(status: EditionStatus, enrollmentDeadline: Date, now: Date): boolean {
  return (
    (status === 'abierta' || status === 'llena') && now.getTime() < enrollmentDeadline.getTime()
  );
}

/** Estado de la edición según cupos ocupados (solo alterna abierta <-> llena). */
export function editionStatusForSeats(
  current: EditionStatus,
  occupied: number,
  maxSeats: number,
): EditionStatus {
  if (current === 'abierta' && occupied >= maxSeats) return 'llena';
  if (current === 'llena' && occupied < maxSeats) return 'abierta';
  return current;
}

export function pendingAmount(total: number, paid: number): number {
  return Math.max(0, total - paid);
}
