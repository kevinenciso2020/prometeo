import { apiGet } from './site';

export interface PublicCampaign {
  id: string;
  placement: 'hero_banner' | 'banner_seccion' | 'popup' | 'barra_superior';
  title: string | null;
  text: string | null;
  ctaText: string | null;
  ctaUrl: string | null;
  imageDesktop: string | null;
  imageMobile: string | null;
  popupFrequencyHours: number;
  priority: number;
  couponCode: string | null;
}

/**
 * Campañas activas para una ruta. Se memoiza por request en `locals`
 * para que layout y página compartan una sola llamada a la API.
 */
export function pageCampaigns(locals: App.Locals, path: string): Promise<PublicCampaign[]> {
  locals.campaigns ??= apiGet<{ items: PublicCampaign[] }>(
    `/public/campaigns?path=${encodeURIComponent(path)}`,
  ).then((r) => r?.items ?? []);
  return locals.campaigns as Promise<PublicCampaign[]>;
}

export const byPlacement = (list: PublicCampaign[], placement: PublicCampaign['placement']) =>
  list.filter((c) => c.placement === placement);
