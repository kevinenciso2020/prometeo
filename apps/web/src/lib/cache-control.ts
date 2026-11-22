/** Rutas con datos personales o de sesión: nunca se cachean. Mantener alineado con `cacheable={false}`. */
const PRIVATE_PREFIXES = [
  '/admin',
  '/api',
  '/carrito',
  '/checkout',
  '/ingresar',
  '/inscribirse',
  '/inscripcion',
  '/mi-cuenta',
  '/pago',
  '/pedido',
  '/recuperar-clave',
  '/registro',
  '/restablecer-clave',
  '/verificar-email',
];

const PUBLIC_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

export function cacheControlFor(pathname: string, status: number): string {
  if (status >= 400) return 'private, no-store';
  const isPrivate = PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return isPrivate ? 'private, no-store' : PUBLIC_CACHE;
}
