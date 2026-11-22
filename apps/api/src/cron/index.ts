import { createPoolDb } from '@prometeo/db';
import type { Bindings } from '../env';
import { mailerFromEnv } from '../lib/mailer';
import { runCron } from './tasks';

/**
 * Handler de Cron Triggers (ver [triggers] en wrangler.toml):
 *  - cada 15 min: vencer reservas, liberar cupos, avisar a la lista de espera
 *  - cada hora: cerrar inscripciones vencidas y enviar recordatorios (reserva por vencer, saldo)
 *  - diario 10:00 UTC (5:00 Bogotá): recordatorio de clases del día siguiente y finalizar ediciones
 * Todas las tareas son idempotentes (reclaman filas con UPDATE condicional) y dejan logs.
 */
export async function scheduled(
  controller: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  const task = runCron(
    controller.cron,
    { open: () => createPoolDb(env.DATABASE_URL), mailer: mailerFromEnv(env), webUrl: env.WEB_URL },
    new Date(controller.scheduledTime),
  ).catch((e) => console.error('[cron] error:', e instanceof Error ? e.message : 'desconocido'));
  ctx.waitUntil(task);
  await task;
}
