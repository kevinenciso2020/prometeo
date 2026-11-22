import {
  ALLOWED_IMAGE_FORMATS,
  MAX_IMAGE_BYTES,
  formatCop,
  type UploadFolder,
} from '@prometeo/shared';

export { formatCop };

/** Base de la API desde el NAVEGADOR: mismo origen (proxy en pages/api/[...path].ts), así las cookies de sesión son de primera parte. */
export const API_URL = '/api';
export const CLOUD_NAME: string = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; fields?: { path: string; message: string }[] };
}

async function rawFetch(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  refreshing ??= rawFetch('/auth/refresh', 'POST', {})
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Llama a la API con cookies; si el access token venció, renueva y reintenta una vez. */
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res = await rawFetch(path, method, body);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await rawFetch(path, method, body);
    if (res.status === 401) {
      location.href = `/admin/login?next=${encodeURIComponent(location.pathname)}`;
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sesión vencida');
    }
  }
  const data = (await res.json().catch(() => ({}))) as T & ErrorBody;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error?.code ?? 'ERROR',
      data.error?.message ?? 'Ocurrió un error',
      data.error?.fields,
    );
  }
  return data;
}

/* ---------- UI helpers ---------- */
export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast--${kind}`;
  t.textContent = message;
  host.append(t);
  setTimeout(() => t.remove(), 4500);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.fields.length
      ? `${err.message}: ${err.fields.map((f) => f.message).join(' · ')}`
      : err.message;
  }
  return 'No se pudo conectar con el servidor';
}

export function $<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento no encontrado: ${selector}`);
  return el;
}

export function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** Lee un formulario: number → entero/null, checkbox → boolean, texto vacío → null. */
export function readForm(form: HTMLFormElement): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const el of Array.from(form.elements)) {
    if (!(
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ))
      continue;
    if (!el.name) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') out[el.name] = el.checked;
    else if (el instanceof HTMLInputElement && el.type === 'number')
      out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value.trim() === '' ? null : el.value;
  }
  return out;
}

export function fillForm(form: HTMLFormElement, data: Record<string, unknown>): void {
  for (const el of Array.from(form.elements)) {
    if (!(
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ))
      continue;
    const v = data[el.name];
    if (v === undefined) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v === null ? '' : String(v);
  }
}

/* ---------- Cloudinary ---------- */
interface Signed {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  allowedFormats: string;
  signature: string;
  uploadUrl: string;
}

export function validateImageFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!(ALLOWED_IMAGE_FORMATS as readonly string[]).includes(ext))
    return `Formato no permitido (${ALLOWED_IMAGE_FORMATS.join(', ')})`;
  if (file.size > MAX_IMAGE_BYTES)
    return `La imagen supera ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`;
  return null;
}

/** Subida firmada directa a Cloudinary: el API_SECRET nunca llega al navegador. */
export async function uploadImage(
  file: File,
  folder: UploadFolder,
): Promise<{ url: string; publicId: string }> {
  const problem = validateImageFile(file);
  if (problem) throw new Error(problem);
  const s = await api<Signed>('/admin/uploads/signature', 'POST', { folder });
  const form = new FormData();
  form.set('file', file);
  form.set('api_key', s.apiKey);
  form.set('timestamp', String(s.timestamp));
  form.set('folder', s.folder);
  form.set('allowed_formats', s.allowedFormats);
  form.set('signature', s.signature);
  const res = await fetch(s.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Cloudinary rechazó la imagen');
  const data = (await res.json()) as { secure_url: string; public_id: string };
  return { url: data.secure_url, publicId: data.public_id };
}

/** Miniatura optimizada con transformaciones de Cloudinary en la URL. */
export function thumb(url: string, width = 240): string {
  return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width},c_fill,ar_1:1/`);
}

/* ---------- Fechas (America/Bogota = UTC-5, sin horario de verano) ---------- */
const BOGOTA_OFFSET_MS = 5 * 3_600_000;

/** Valor de <input type="datetime-local"> interpretado en hora de Colombia -> ISO con offset. */
export function toBogotaIso(local: string): string {
  return `${local.length === 16 ? `${local}:00` : local}-05:00`;
}

/** ISO/Date -> "YYYY-MM-DDTHH:mm" en hora de Colombia, para <input type="datetime-local">. */
export function toBogotaLocal(value: string | Date): string {
  return new Date(new Date(value).getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 16);
}

export function fmtBogota(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(value));
}

/** Descarga un archivo autenticado (con renovación de sesión si hace falta). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let res = await fetch(`${API_URL}${path}`, { credentials: 'include' });
  if (res.status === 401 && (await refreshSession()))
    res = await fetch(`${API_URL}${path}`, { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD', 'No se pudo descargar el archivo');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
