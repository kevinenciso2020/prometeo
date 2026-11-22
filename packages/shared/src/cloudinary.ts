/** Carpetas permitidas para subir imágenes (se firman en el servidor). */
export const UPLOAD_FOLDERS = [
  'prometeo/products',
  'prometeo/categories',
  'prometeo/services',
  'prometeo/courses',
  'prometeo/campaigns',
] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

export const ALLOWED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MANAGED_PREFIX = 'prometeo/';

export function cloudinaryBase(cloudName: string): string {
  return `https://res.cloudinary.com/${cloudName}/`;
}

/** Solo se aceptan URLs https de res.cloudinary.com/<CLOUD_NAME>/. */
export function isCloudinaryUrl(url: string, cloudName: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'res.cloudinary.com' &&
      u.pathname.startsWith(`/${cloudName}/`) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

/**
 * Extrae el public_id de una URL de Cloudinary:
 * .../image/upload/[transformaciones/][v123/]carpeta/nombre.ext
 */
export function parseCloudinaryUrl(
  url: string,
  cloudName: string,
): { url: string; publicId: string } | null {
  if (!isCloudinaryUrl(url, cloudName)) return null;
  const { pathname } = new URL(url);
  const marker = '/upload/';
  const idx = pathname.indexOf(marker);
  if (idx === -1) return null;
  const segments = pathname
    .slice(idx + marker.length)
    .split('/')
    .filter(Boolean);
  // Descarta transformaciones (contienen "_" o ",") hasta llegar a la versión o al id.
  while (segments.length > 1) {
    const s = segments[0] ?? '';
    if (/^v\d+$/.test(s)) {
      segments.shift();
      break;
    }
    if (/[,_]/.test(s) && !s.includes('.')) segments.shift();
    else break;
  }
  const last = segments.pop();
  if (!last) return null;
  const publicId = [...segments, last.replace(/\.[a-z0-9]+$/i, '')]
    .map(decodeURIComponent)
    .join('/');
  return publicId ? { url, publicId } : null;
}

/** ¿Es un recurso gestionado por Prometeo (carpeta prometeo/)? Solo esos se borran en Cloudinary. */
export function isManagedPublicId(publicId: string): boolean {
  return publicId.startsWith(MANAGED_PREFIX) && !publicId.includes('..');
}
