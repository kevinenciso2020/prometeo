/**
 * Utilidades de Wompi (Colombia): firma de integridad del checkout y verificación
 * del checksum de eventos (webhook). Funciones puras sobre Web Crypto.
 */
import { fromHexLoose, sha256Hex, timingSafeEqual } from './crypto';

export const WOMPI_STATUSES = ['APPROVED', 'DECLINED', 'VOIDED', 'ERROR', 'PENDING'] as const;
export type WompiStatus = (typeof WOMPI_STATUSES)[number];

export interface IntegrityInput {
  reference: string;
  /** Monto en CENTAVOS (pesos * 100). */
  amountInCents: number;
  currency?: 'COP';
  /** Opcional: fecha de expiración ISO 8601 (se firma antes del secreto). */
  expirationTime?: string;
  secret: string;
}

/** SHA256(referencia + montoEnCentavos + moneda [+ expiración] + secretoIntegridad), en hexadecimal. */
export function wompiIntegritySignature(i: IntegrityInput): Promise<string> {
  if (!Number.isInteger(i.amountInCents) || i.amountInCents <= 0) {
    throw new RangeError('amountInCents debe ser un entero positivo');
  }
  return sha256Hex(
    `${i.reference}${i.amountInCents}${i.currency ?? 'COP'}${i.expirationTime ?? ''}${i.secret}`,
  );
}

export interface WompiEvent {
  event: string;
  data: Record<string, unknown>;
  environment?: string;
  signature: { properties: string[]; checksum: string };
  timestamp: number;
  sent_at?: string;
}

/** Propiedades que SIEMPRE deben estar firmadas para confiar en el estado de una transacción. */
const REQUIRED_PROPERTIES = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];

function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Concatena los valores de `signature.properties` (en orden) + timestamp + secreto de eventos y aplica SHA256. */
export async function computeEventChecksum(
  event: WompiEvent,
  eventsSecret: string,
): Promise<string | null> {
  let concatenated = '';
  for (const prop of event.signature.properties) {
    const v = resolvePath(event.data, prop);
    if (v === undefined || v === null || typeof v === 'object') return null;
    concatenated += String(v);
  }
  return sha256Hex(`${concatenated}${event.timestamp}${eventsSecret}`);
}

export async function verifyEventChecksum(
  event: WompiEvent,
  eventsSecret: string,
): Promise<boolean> {
  const props = event.signature?.properties;
  if (!Array.isArray(props) || !REQUIRED_PROPERTIES.every((p) => props.includes(p))) return false;
  const expected = await computeEventChecksum(event, eventsSecret);
  const given = event.signature.checksum;
  if (!expected || typeof given !== 'string') return false;
  const a = fromHexLoose(expected);
  const b = fromHexLoose(given.toLowerCase());
  return a !== null && b !== null && timingSafeEqual(a, b);
}

export interface WompiTransactionInfo {
  id: string;
  status: WompiStatus;
  amountInCents: number;
  reference: string;
  currency: string;
}

export function parseWompiTransaction(event: WompiEvent): WompiTransactionInfo | null {
  const t = (event.data as { transaction?: Record<string, unknown> }).transaction;
  if (!t) return null;
  const { id, status, amount_in_cents: amount, reference, currency } = t;
  if (typeof id !== 'string' || typeof reference !== 'string' || typeof amount !== 'number')
    return null;
  if (typeof status !== 'string' || !(WOMPI_STATUSES as readonly string[]).includes(status))
    return null;
  return {
    id,
    status: status as WompiStatus,
    amountInCents: amount,
    reference,
    currency: typeof currency === 'string' ? currency : 'COP',
  };
}
