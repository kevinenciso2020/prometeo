import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { requireRole } from '../../middleware/auth';
import { categoriesRoutes } from './categories';
import { coursesRoutes } from './courses';
import { editionsRoutes } from './editions';
import { enrollmentsRoutes } from './enrollments';
import { ordersRoutes } from './orders';
import { productsRoutes } from './products';
import { quotesRoutes } from './quotes';
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
adminRoutes.route('/courses', coursesRoutes);
adminRoutes.route('/editions', editionsRoutes);
adminRoutes.route('/enrollments', enrollmentsRoutes);
adminRoutes.route('/orders', ordersRoutes);
adminRoutes.route('/quotes', quotesRoutes);
adminRoutes.route('/settings', settingsRoutes);
adminRoutes.route('/users', usersRoutes);
