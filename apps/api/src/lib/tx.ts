import type { Db } from '@prometeo/db';

export interface PoolHandle {
  db: Db;
  close: () => Promise<void>;
}
/** Abre una conexión con soporte de transacciones (Pool WebSocket de Neon). Una por operación. */
export type PoolOpener = () => PoolHandle;

/**
 * Ejecuta `fn` dentro de una transacción y SIEMPRE cierra la conexión al terminar.
 * neon-http no soporta transacciones: por eso se usa el Pool WebSocket (creado y cerrado por request).
 */
export async function withTransaction<T>(open: PoolOpener, fn: (tx: Db) => Promise<T>): Promise<T> {
  const handle = open();
  try {
    return await handle.db.transaction((tx) => fn(tx as unknown as Db));
  } finally {
    await handle.close();
  }
}
