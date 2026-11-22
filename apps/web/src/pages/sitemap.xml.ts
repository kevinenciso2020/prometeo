import type { APIRoute } from 'astro';
import {
  SITE_URL,
  apiGet,
  type CategoryData,
  type CourseListItem,
  type Paged,
  type ProductCardData,
  type ServiceData,
} from '../lib/site';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const GET: APIRoute = async () => {
  const urls: string[] = [
    '/',
    '/tienda',
    '/cursos',
    '/servicios',
    '/el-taller',
    '/contacto',
    '/terminos',
    '/privacidad',
    '/envios-y-devoluciones',
  ];

  const courses = await apiGet<{ items: CourseListItem[] }>('/public/courses');
  courses?.items.forEach((c) => urls.push(`/cursos/${c.slug}`));
  const [cats, services] = await Promise.all([
    apiGet<{ items: CategoryData[] }>('/public/categories'),
    apiGet<{ items: ServiceData[] }>('/public/services'),
  ]);
  cats?.items.forEach((c) => urls.push(`/tienda?category=${c.slug}`));
  services?.items.forEach((s) => urls.push(`/servicios/${s.slug}`));

  for (let page = 1; page <= 50; page++) {
    const r = await apiGet<Paged<ProductCardData>>(`/public/products?pageSize=48&page=${page}`);
    if (!r) break;
    r.items.forEach((p) => urls.push(`/producto/${p.slug}`));
    if (page >= r.totalPages) break;
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(SITE_URL + u)}</loc></url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
