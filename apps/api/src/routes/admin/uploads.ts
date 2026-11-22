import { Hono } from 'hono';
import { destroyUploadSchema, uploadSignatureSchema } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { validate } from '../../lib/validate';

export const uploadsRoutes = new Hono<AppEnv>();

/** Firma una subida directa a Cloudinary. El API_SECRET nunca sale del servidor. */
uploadsRoutes.post('/signature', validate('json', uploadSignatureSchema), async (c) => {
  const signed = await c.get('cloudinary').signUpload(c.req.valid('json').folder);
  return c.json(signed);
});

/** Borra una imagen subida que no llegó a guardarse (solo carpeta prometeo/). */
uploadsRoutes.post('/destroy', validate('json', destroyUploadSchema), async (c) => {
  const ok = await c.get('cloudinary').destroy(c.req.valid('json').publicId);
  return c.json({ ok });
});
