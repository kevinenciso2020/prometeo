/**
 * Cabeceras de seguridad del front. Se aplican a TODAS las respuestas SSR desde el middleware.
 *
 * CSP: Astro emite scripts de página en línea (hidratación ligera y JSON-LD), por eso `script-src`
 * lleva 'unsafe-inline'. Se compensa con: sin eval, `object-src 'none'`, `base-uri 'self'`,
 * `frame-ancestors 'none'` y orígenes de conexión/imagen acotados. Migrar a nonces/hashes es una
 * mejora posterior (ver docs/SECURITY-AUDIT.md).
 */
export function buildCsp(apiOrigin: string, upgrade = true): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://res.cloudinary.com",
    `connect-src 'self' ${apiOrigin} https://res.cloudinary.com https://api.cloudinary.com`,
    "frame-src 'none'",
    "form-action 'self' https://checkout.wompi.co",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    ...(upgrade ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function applySecurityHeaders(
  response: Response,
  apiUrl: string,
  isProd: boolean,
): Response {
  let origin = '';
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    origin = '';
  }
  const csp = buildCsp(origin, isProd);
  const h = response.headers;
  h.set('Content-Security-Policy', csp);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (isProd) h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  return response;
}
