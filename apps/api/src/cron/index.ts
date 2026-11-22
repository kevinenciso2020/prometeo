import type { Bindings } from '../env';

/**
 * Handler de Cron Triggers. Se completa en la Fase 4 (vencer reservas, recordatorios, etc.).
 * Cada tarea debe ser idempotente y dejar logs.
 */
export async function scheduled(controller: ScheduledController, _env: Bindings): Promise<void> {
  console.log(
    `[cron] ${controller.cron} ejecutado a las ${new Date(controller.scheduledTime).toISOString()}`,
  );
}
