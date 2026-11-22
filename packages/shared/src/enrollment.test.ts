import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_STATES,
  PAYMENT_HOLD_MINUTES,
  canTransition,
  computeDeposit,
  computeReservedUntil,
  editionStatusForSeats,
  eventForPayment,
  isEditionOpen,
  isTerminal,
  occupiesSeat,
  seatDelta,
  transition,
  type EnrollmentEvent,
  type EnrollmentState,
} from './enrollment';

const EVENTS: EnrollmentEvent[] = ['reserve', 'pay_partial', 'pay_full', 'expire', 'cancel'];

describe('máquina de estados', () => {
  it('define exactamente las transiciones permitidas (tabla completa)', () => {
    const allowed: Record<EnrollmentState, Partial<Record<EnrollmentEvent, EnrollmentState>>> = {
      lista: {
        reserve: 'reservada',
        pay_partial: 'abonada',
        pay_full: 'pagada',
        cancel: 'cancelada',
      },
      reservada: {
        pay_partial: 'abonada',
        pay_full: 'pagada',
        expire: 'vencida',
        cancel: 'cancelada',
      },
      abonada: { pay_partial: 'abonada', pay_full: 'pagada', cancel: 'cancelada' },
      pagada: { cancel: 'cancelada' },
      vencida: {},
      cancelada: {},
    };
    for (const s of ENROLLMENT_STATES) {
      for (const e of EVENTS) {
        expect(transition(s, e), `${s} + ${e}`).toBe(allowed[s][e] ?? null);
      }
    }
  });

  it('vencida y cancelada son terminales', () => {
    expect(isTerminal('vencida')).toBe(true);
    expect(isTerminal('cancelada')).toBe(true);
    expect(isTerminal('lista')).toBe(false);
    for (const e of EVENTS) {
      expect(canTransition('vencida', e)).toBe(false);
      expect(canTransition('cancelada', e)).toBe(false);
    }
  });

  it('solo una reserva puede vencer: abonada y pagada no vencen', () => {
    expect(canTransition('reservada', 'expire')).toBe(true);
    expect(canTransition('abonada', 'expire')).toBe(false);
    expect(canTransition('pagada', 'expire')).toBe(false);
    expect(canTransition('lista', 'expire')).toBe(false);
  });
});

describe('cupos', () => {
  it('reservada, abonada y pagada ocupan cupo; lista no', () => {
    expect(ENROLLMENT_STATES.filter(occupiesSeat)).toEqual(['reservada', 'abonada', 'pagada']);
  });

  it('seatDelta refleja cuándo se gana o libera un cupo', () => {
    expect(seatDelta('lista', 'reservada')).toBe(1);
    expect(seatDelta('lista', 'pagada')).toBe(1);
    expect(seatDelta('reservada', 'abonada')).toBe(0);
    expect(seatDelta('abonada', 'pagada')).toBe(0);
    expect(seatDelta('reservada', 'vencida')).toBe(-1);
    expect(seatDelta('pagada', 'cancelada')).toBe(-1);
    expect(seatDelta('lista', 'cancelada')).toBe(0);
  });

  it('toda transición válida es consistente con seatDelta', () => {
    for (const s of ENROLLMENT_STATES) {
      for (const e of EVENTS) {
        const to = transition(s, e);
        if (to) expect([-1, 0, 1]).toContain(seatDelta(s, to));
      }
    }
  });

  it('la edición alterna abierta <-> llena según ocupación', () => {
    expect(editionStatusForSeats('abierta', 8, 8)).toBe('llena');
    expect(editionStatusForSeats('abierta', 7, 8)).toBe('abierta');
    expect(editionStatusForSeats('llena', 7, 8)).toBe('abierta');
    expect(editionStatusForSeats('llena', 8, 8)).toBe('llena');
    expect(editionStatusForSeats('cerrada', 0, 8)).toBe('cerrada');
    expect(editionStatusForSeats('cancelada', 8, 8)).toBe('cancelada');
  });
});

describe('pagos y abonos', () => {
  it('eventForPayment distingue pago parcial y completo', () => {
    expect(eventForPayment(100, 300)).toBe('pay_partial');
    expect(eventForPayment(300, 300)).toBe('pay_full');
    expect(eventForPayment(350, 300)).toBe('pay_full');
  });

  it('computeDeposit por porcentaje redondea hacia arriba y respeta límites', () => {
    expect(computeDeposit(320_000, 'porcentaje', 30)).toBe(96_000);
    expect(computeDeposit(100_001, 'porcentaje', 30)).toBe(30_001);
    expect(computeDeposit(100_000, 'porcentaje', 100)).toBe(100_000);
  });

  it('computeDeposit por monto fijo nunca supera el precio ni baja de 1', () => {
    expect(computeDeposit(200_000, 'monto', 50_000)).toBe(50_000);
    expect(computeDeposit(40_000, 'monto', 50_000)).toBe(40_000);
    expect(computeDeposit(40_000, 'monto', 0)).toBe(1);
    expect(computeDeposit(0, 'porcentaje', 30)).toBe(0);
  });
});

describe('reservas y fechas límite', () => {
  const now = new Date('2026-03-01T12:00:00Z');
  const farDeadline = new Date('2026-04-01T00:00:00Z');

  it('lista no retiene cupo', () => {
    expect(computeReservedUntil(now, 'lista', 48, farDeadline)).toBeNull();
  });

  it('reserva dura las horas configuradas', () => {
    expect(computeReservedUntil(now, 'reserva', 48, farDeadline)?.toISOString()).toBe(
      '2026-03-03T12:00:00.000Z',
    );
  });

  it('la reserva NUNCA supera la fecha límite de inscripción', () => {
    const deadline = new Date('2026-03-02T00:00:00Z');
    expect(computeReservedUntil(now, 'reserva', 48, deadline)?.toISOString()).toBe(
      deadline.toISOString(),
    );
  });

  it('total y abono retienen el cupo solo mientras se paga', () => {
    const until = computeReservedUntil(now, 'total', 48, farDeadline);
    expect(until?.getTime()).toBe(now.getTime() + PAYMENT_HOLD_MINUTES * 60_000);
    expect(computeReservedUntil(now, 'abono', 48, farDeadline)?.getTime()).toBe(until?.getTime());
  });

  it('isEditionOpen exige estado abierta/llena y fecha límite vigente', () => {
    expect(isEditionOpen('abierta', farDeadline, now)).toBe(true);
    expect(isEditionOpen('llena', farDeadline, now)).toBe(true);
    expect(isEditionOpen('cerrada', farDeadline, now)).toBe(false);
    expect(isEditionOpen('cancelada', farDeadline, now)).toBe(false);
    expect(isEditionOpen('finalizada', farDeadline, now)).toBe(false);
    expect(isEditionOpen('abierta', now, now)).toBe(false);
    expect(isEditionOpen('abierta', new Date('2026-02-01T00:00:00Z'), now)).toBe(false);
  });
});
