import { TIMEZONE } from '@prometeo/shared';

export function fmtDateTime(d: Date | string): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: TIMEZONE,
  }).format(new Date(d));
}
export function fmtDate(d: Date | string): string {
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: TIMEZONE }).format(
    new Date(d),
  );
}

/** Rango [inicio, fin) del "día siguiente" en America/Bogota (UTC-5, sin horario de verano). */
export function tomorrowRangeBogota(now: Date): { start: Date; end: Date } {
  const bog = new Date(now.getTime() - 5 * 3_600_000);
  const start = new Date(
    Date.UTC(bog.getUTCFullYear(), bog.getUTCMonth(), bog.getUTCDate() + 1, 5, 0, 0),
  );
  return { start, end: new Date(start.getTime() + 24 * 3_600_000) };
}

/** Fecha YYYY-MM-DD en America/Bogota (para contadores diarios de campañas). */
export function bogotaDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
