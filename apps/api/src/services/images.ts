import { and, eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { productImages, serviceImages, type Db } from '@prometeo/db';
import { isCloudinaryUrl, type ImageInput } from '@prometeo/shared';
import { AuthError } from './auth.service';

type ImageTable = typeof productImages | typeof serviceImages;

export interface ImageStore {
  table: ImageTable;
  fk: PgColumn;
  fkKey: 'productId' | 'serviceId';
}

export const productImageStore: ImageStore = {
  table: productImages,
  fk: productImages.productId,
  fkKey: 'productId',
};
export const serviceImageStore: ImageStore = {
  table: serviceImages,
  fk: serviceImages.serviceId,
  fkKey: 'serviceId',
};

export function assertCloudinaryImages(images: ImageInput[], cloudName: string): void {
  for (const img of images) {
    if (!isCloudinaryUrl(img.url, cloudName)) {
      throw new AuthError(
        400,
        'INVALID_IMAGE',
        'Las imágenes deben provenir de tu cuenta de Cloudinary',
      );
    }
  }
}

/**
 * Sincroniza la galería: inserta nuevas, actualiza orden/principal y elimina las ausentes.
 * Devuelve los public_id eliminados para borrarlos también en Cloudinary.
 */
export async function syncImages(
  db: Db,
  store: ImageStore,
  parentId: string,
  incoming: ImageInput[],
): Promise<string[]> {
  const { table, fk, fkKey } = store;
  const existing = await db.select().from(table).where(eq(fk, parentId));
  const keep = new Set(incoming.map((i) => i.publicId));
  const removed = existing.filter((e) => !keep.has(e.publicId));

  if (removed.length) {
    await db.delete(table).where(
      and(
        eq(fk, parentId),
        inArray(
          table.id,
          removed.map((r) => r.id),
        ),
      ),
    );
  }
  // Evita chocar con el índice único de "una sola principal" mientras se reasigna.
  await db.update(table).set({ isPrimary: false }).where(eq(fk, parentId));

  const primaryIdx = Math.max(
    0,
    incoming.findIndex((i) => i.isPrimary),
  );
  const byPublicId = new Map(existing.map((e) => [e.publicId, e.id]));
  for (const [index, img] of incoming.entries()) {
    const common = {
      url: img.url,
      alt: img.alt,
      sortOrder: index,
      isPrimary: index === primaryIdx,
    };
    const rowId = byPublicId.get(img.publicId);
    if (rowId) {
      await db.update(table).set(common).where(eq(table.id, rowId));
    } else {
      // Las tablas comparten forma; solo cambia el nombre de la columna padre.
      await db.insert(table).values({
        ...common,
        publicId: img.publicId,
        [fkKey]: parentId,
      } as typeof productImages.$inferInsert);
    }
  }
  return removed.map((r) => r.publicId);
}
