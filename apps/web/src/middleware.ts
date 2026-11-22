import { defineMiddleware } from 'astro:middleware';

const API = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8787';
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login', '/admin/sesion']);

interface MeResponse {
  user: { id: string; email: string; name: string; role: 'CLIENTE' | 'ADMIN' | 'SUPER_ADMIN' };
}

/**
 * Protege /admin en el servidor: valida la sesión contra la API antes de renderizar.
 * (No basta con ocultar enlaces en el cliente.)
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (!pathname.startsWith('/admin') || PUBLIC_ADMIN_PATHS.has(pathname)) return next();

  let user: MeResponse['user'] | null = null;
  try {
    const res = await fetch(`${API}/auth/me`, {
      headers: { cookie: context.request.headers.get('cookie') ?? '' },
    });
    if (res.ok) user = ((await res.json()) as MeResponse).user;
  } catch {
    user = null;
  }

  if (!user) {
    // El access token dura 15 min: /admin/sesion intenta renovarlo con el refresh token.
    const target = `${pathname}${context.url.search}`;
    return context.redirect(`/admin/sesion?next=${encodeURIComponent(target)}`);
  }
  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    return new Response('No tienes permisos para acceder al panel.', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (pathname.startsWith('/admin/administradores') && user.role !== 'SUPER_ADMIN') {
    return new Response('Solo un SUPER_ADMIN puede gestionar administradores.', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  context.locals.user = user;
  const response = await next();
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
