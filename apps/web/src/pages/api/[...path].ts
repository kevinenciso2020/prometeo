import type { APIRoute } from 'astro';
import { serverFetch } from '../../lib/api-server';

export const prerender = false;

/**
 * Proxy a la API en el MISMO origen que la web (`/api/*` → API).
 * Así el navegador solo habla con un origen: las cookies de sesión son de primera parte y
 * el login y el panel funcionan sin dominio propio (p. ej. en *.workers.dev, donde web y API
 * serían sitios distintos). Con dominio propio sigue funcionando igual.
 */
export const ALL: APIRoute = async ({ request, params, url }) => {
  const path = `/${params.path ?? ''}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await serverFetch(path, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    // @ts-expect-error `duplex` es necesario para reenviar el cuerpo como stream.
    duplex: 'half',
  });
  // Respuesta nueva: sus cabeceras son mutables (el middleware añade las de seguridad).
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};
