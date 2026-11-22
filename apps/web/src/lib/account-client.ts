import { API_URL } from './site';

export class AccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ErrBody {
  error?: { message?: string; fields?: { message: string }[] };
}

async function raw(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Llama a la API (cookies httpOnly). Si el access token venció, renueva con el refresh y reintenta una vez. */
export async function call<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  opts: { redirectOn401?: string } = {},
): Promise<T> {
  let res = await raw(path, method, body);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const r = await raw('/auth/refresh', 'POST', {});
    if (r.ok) res = await raw(path, method, body);
    if (res.status === 401 && opts.redirectOn401) {
      location.href = `/ingresar?next=${encodeURIComponent(opts.redirectOn401)}`;
      throw new AccountError(401, 'Sesión vencida');
    }
  }
  const data = (await res.json().catch(() => ({}))) as T & ErrBody;
  if (!res.ok) {
    const fields = data.error?.fields?.map((f) => f.message).join(' · ');
    throw new AccountError(res.status, fields || data.error?.message || 'Ocurrió un error');
  }
  return data;
}

export const errText = (e: unknown): string =>
  e instanceof AccountError ? e.message : 'No pudimos conectar con el servidor';
