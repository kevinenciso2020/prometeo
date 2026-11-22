import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { requireRole } from '../../middleware/auth';
import { categoriesRoutes } from './categories';
import { productsRoutes } from './products';
import { servicesRoutes } from './services';
import { settingsRoutes } from './settings';
import { uploadsRoutes } from './uploads';
import { usersRoutes } from './users';

/** Todas las rutas /admin/* exigen rol ADMIN o SUPER_ADMIN en el servidor. */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireRole('ADMIN', 'SUPER_ADMIN'));

adminRoutes.get('/ping', (c) => c.json({ ok: true, role: c.get('user')?.role }));

adminRoutes.route('/uploads', uploadsRoutes);
adminRoutes.route('/categories', categoriesRoutes);
adminRoutes.route('/products', productsRoutes);
adminRoutes.route('/services', servicesRoutes);
adminRoutes.route('/settings', settingsRoutes);
adminRoutes.route('/users', usersRoutes);
