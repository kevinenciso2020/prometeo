import { API_URL } from './site';

/**
 * Métricas de campañas: contadores agregados, sin cookies ni identificadores.
 * `keepalive` permite que el clic se registre aunque la página cambie de inmediato.
 */
const seen = new Set<string>();

export function track(id: string, type: 'impression' | 'click'): void {
  try {
    void fetch(`${API_URL}/public/campaigns/${id}/events`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    }).catch(() => undefined);
  } catch {
    /* las métricas nunca deben romper la página */
  }
}

/** Una impresión por campaña y por carga de página. */
export function trackImpressionOnce(id: string): void {
  if (seen.has(id)) return;
  seen.add(id);
  track(id, 'impression');
}

/** Registra impresiones al ver (50%) los elementos [data-campaign-id] y clics en [data-campaign-cta]. */
export function initCampaignTracking(): void {
  const io =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const id = (e.target as HTMLElement).dataset.campaignId;
              if (id) trackImpressionOnce(id);
              io?.unobserve(e.target);
            }
          },
          { threshold: 0.5 },
        )
      : null;
  document.querySelectorAll<HTMLElement>('[data-campaign-id][data-track="view"]').forEach((el) => {
    if (io) io.observe(el);
    else if (el.dataset.campaignId) trackImpressionOnce(el.dataset.campaignId);
  });
  document.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-campaign-cta]');
    const id = a?.dataset.campaignCta;
    if (id) track(id, 'click');
  });
}
