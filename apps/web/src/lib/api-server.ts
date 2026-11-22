import { env } from 'cloudflare:workers';

const API_URL: string = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8787';

interface ApiBinding {
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Llamada SSR (servidor → API). En Cloudflare un Worker no puede llamar a otro Worker de la
 * misma cuenta por su URL pública (error 1042), así que se usa el service binding `API`.
 * Sin binding (desarrollo local) o si falla, se usa `fetch` a PUBLIC_API_URL.
 */
export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const binding = (env as unknown as { API?: ApiBinding }).API;
  if (binding) {
    try {
      return await binding.fetch(new Request(`https://api.internal${path}`, init));
    } catch {
      /* cae al fetch público */
    }
  }
  return fetch(`${API_URL}${path}`, init);
}
