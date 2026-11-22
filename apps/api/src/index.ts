import { Hono } from 'hono';
import { createHttpDb, createPoolDb, type Db } from '@prometeo/db';
import { scheduled } from './cron';
import type { AppEnv, Bindings } from './env';
import { mailerFromEnv, type Mailer } from './lib/mailer';
import type { PoolOpener } from './lib/tx';
import { onError, onNotFound } from './middleware/errors';
import { corsPolicy, originCheck, securityHeaders } from './middleware/security';
import { accountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { createCloudinary, type CloudinaryClient } from './lib/cloudinary';
import { authRoutes } from './routes/auth';
import { health } from './routes/health';
import { publicRoutes } from './routes/public';
import { publicCampaignRoutes } from './routes/public-campaigns';
import { publicCoursesRoutes } from './routes/public-courses';
import { publicOrderRoutes } from './routes/public-orders';
import { webhooks } from './routes/webhooks';

export interface AppDeps {
  /** Inyectables para tests. Por defecto: Neon (HTTP) y Resend/consola. */
  getDb?: (env: Bindings) => Db;
  getMailer?: (env: Bindings) => Mailer;
  getCloudinary?: (env: Bindings) => CloudinaryClient;
  /** Conexión con transacciones (Pool WebSocket). En tests devuelve la misma BD en memoria. */
  getPool?: (env: Bindings) => PoolOpener;
}

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders);
  app.use('*', corsPolicy);
  app.use('*', originCheck);
  app.use('*', async (c, next) => {
    c.set('db', (deps.getDb ?? ((env) => createHttpDb(env.DATABASE_URL)))(c.env));
    c.set('mailer', (deps.getMailer ?? mailerFromEnv)(c.env));
    c.set(
      'cloudinary',
      (
        deps.getCloudinary ??
        ((env) =>
          createCloudinary({
            cloudName: env.CLOUDINARY_CLOUD_NAME,
            apiKey: env.CLOUDINARY_API_KEY,
            apiSecret: env.CLOUDINARY_API_SECRET,
          }))
      )(c.env),
    );
    c.set('openPool', (deps.getPool ?? ((env) => () => createPoolDb(env.DATABASE_URL)))(c.env));
    await next();
  });

  app.route('/health', health);
  app.route('/auth', authRoutes);
  app.route('/admin', adminRoutes);
  app.route('/public', publicRoutes);
  app.route('/public', publicCoursesRoutes);
  app.route('/public', publicOrderRoutes);
  app.route('/public', publicCampaignRoutes);
  app.route('/account', accountRoutes);
  app.route('/webhooks', webhooks);

  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Bindings>;
