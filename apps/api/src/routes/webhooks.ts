import { Hono, type Context } from 'hono';
import { parseWompiTransaction, verifyEventChecksum, type WompiEvent } from '@prometeo/shared';
import type { AppEnv } from '../env';
import { rateLimit } from '../middleware/rate-limit';
import { handleWompiTransaction } from '../services/payments.service';

/** Webhooks de proveedores. Se autentican por FIRMA (no por cookies ni Origin) y son idempotentes. */
export const webhooks = new Hono<AppEnv>();

const MAX_BODY = 100_000;
const reject = (c: Context<AppEnv>, status: 400 | 401 | 413, code: string) =>
  c.json(
    { error: { code, message: status === 401 ? 'Firma inválida' : 'Solicitud inválida' } },
    status,
  );

function isWompiEvent(v: unknown): v is WompiEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<WompiEvent>;
  return (
    typeof e.event === 'string' &&
    typeof e.timestamp === 'number' &&
    !!e.data &&
    typeof e.data === 'object' &&
    !!e.signature &&
    Array.isArray(e.signature.properties) &&
    e.signature.properties.every((p) => typeof p === 'string') &&
    typeof e.signature.checksum === 'string'
  );
}

webhooks.post('/wompi', rateLimit('RL_WEBHOOK', 'wompi'), async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return reject(c, 413, 'TOO_LARGE');
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return reject(c, 400, 'BAD_JSON');
  }
  if (!isWompiEvent(event)) return reject(c, 400, 'BAD_EVENT');

  // 1) Firma: checksum del cuerpo (y del header X-Event-Checksum, si viene, debe coincidir).
  const header = c.req.header('x-event-checksum');
  if (header && header.toLowerCase() !== event.signature.checksum.toLowerCase())
    return reject(c, 401, 'BAD_SIGNATURE');
  if (!(await verifyEventChecksum(event, c.env.WOMPI_EVENTS_SECRET)))
    return reject(c, 401, 'BAD_SIGNATURE');

  // 2) Solo nos interesan las transacciones.
  if (event.event !== 'transaction.updated') return c.json({ ok: true, ignored: true });
  const tx = parseWompiTransaction(event);
  if (!tx) return reject(c, 400, 'BAD_TRANSACTION');

  // 3) Si algo falla aquí respondemos 500 y Wompi reintenta; el procesamiento es idempotente.
  const result = await handleWompiTransaction(
    { db: c.get('db'), open: c.get('openPool'), mailer: c.get('mailer'), webUrl: c.env.WEB_URL },
    tx,
    event,
  );
  return c.json({ ok: true, result });
});
