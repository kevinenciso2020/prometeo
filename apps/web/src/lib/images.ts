/** Transformaciones de Cloudinary en la URL: f_auto,q_auto,w_... */
const WIDTHS = [320, 480, 640, 800, 1024, 1400];

export function isCloudinary(url: string): boolean {
  return url.startsWith('https://res.cloudinary.com/') && url.includes('/upload/');
}

export function cld(url: string, width: number, extra = ''): string {
  if (!isCloudinary(url)) return url;
  return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width}${extra ? `,${extra}` : ''}/`);
}

export function srcset(url: string, extra = ''): string {
  if (!isCloudinary(url)) return '';
  return WIDTHS.map((w) => `${cld(url, w, extra)} ${w}w`).join(', ');
}

/** Imagen para Open Graph (1200x630). */
export function ogImage(url: string | null | undefined): string | undefined {
  return url ? cld(url, 1200, 'c_fill,h_630') : undefined;
}
