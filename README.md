# Prometeo

Tienda y escuela de cerámica artesanal: catálogo, carrito y pagos con Wompi, cursos con ediciones e inscripciones (cupos, reservas, abonos, lista de espera), campañas, cupones y panel de administración.

**Stack:** pnpm monorepo · `apps/api` (Hono en Cloudflare Workers) · `apps/web` (Astro SSR en Cloudflare) · `packages/db` (Drizzle + Neon Postgres) · `packages/shared` (Zod y utilidades) · Cloudinary · Wompi · Resend.

## Desarrollo local

Requisitos: Node ≥ 22.23.4 (Astro 7; `.nvmrc` apunta a la última 22.x) y pnpm.

```bash
pnpm install
cp .env.example .env                       # solo para migrar/sembrar (DATABASE_URL directa de Neon)
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env
pnpm db:migrate                            # aplica migraciones
pnpm db:seed                               # admin inicial (ADMIN_EMAIL/ADMIN_PASSWORD), categorías y datos demo
pnpm dev                                   # api :8787 y web :4321
```

Comandos útiles: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm db:generate` (nueva migración tras cambiar el esquema).

## Despliegue en Cloudflare

Arquitectura: dos Workers — `prometeo-api` en `api.<dominio>` y `prometeo-web` en `<dominio>`. Comparten cookies con `Domain=.<dominio>`.

### 1. Base de datos (Neon)

1. Crea el proyecto y copia dos cadenas: **directa** (para migrar) y **pooled** (host con `-pooler`, para el Worker).
2. Migra: `DATABASE_URL="<directa>" pnpm db:migrate:ci`.
3. Siembra el admin inicial una sola vez: `pnpm db:seed` (con `.env` apuntando a la directa) y **cambia la clave** al ingresar.

### 2. API

Edita el bloque **`[env.production.vars]`** de `apps/api/wrangler.toml` (el `[vars]` de arriba es solo para desarrollo local; wrangler no hereda variables entre entornos):

| Variable                | Producción                                                     |
| ----------------------- | -------------------------------------------------------------- |
| `ENVIRONMENT`           | `production`                                                   |
| `WEB_ORIGIN`            | `https://<dominio>` (exacto: CORS y verificación de Origin)    |
| `WEB_URL`               | `https://<dominio>`                                            |
| `COOKIE_DOMAIN`         | `.<dominio>`                                                   |
| `EMAIL_FROM`            | `Prometeo <no-reply@<dominio>>` (dominio verificado en Resend) |
| `CLOUDINARY_CLOUD_NAME` | tu cloud name                                                  |
| `WOMPI_PUBLIC_KEY`      | `pub_prod_…`                                                   |

Secretos (`cd apps/api`):

```bash
pnpm exec wrangler secret put DATABASE_URL --env production            # cadena pooled
pnpm exec wrangler secret put JWT_SECRET --env production              # openssl rand -base64 48
pnpm exec wrangler secret put RESEND_API_KEY --env production
pnpm exec wrangler secret put CLOUDINARY_API_KEY --env production
pnpm exec wrangler secret put CLOUDINARY_API_SECRET --env production
pnpm exec wrangler secret put WOMPI_INTEGRITY_SECRET --env production  # de producción
pnpm exec wrangler secret put WOMPI_EVENTS_SECRET --env production     # de producción
pnpm exec wrangler deploy --env production
```

Los **Cron Triggers** (`*/15 * * * *`, `0 * * * *`, `0 10 * * *`) y los límites de **Rate Limiting** (`[[env.production.ratelimits]]`) se publican con `wrangler deploy --env production`. Cada ejecución del cron deja logs (`wrangler tail`).

### 3. Cloudinary

El panel sube las imágenes directamente a Cloudinary con una firma que genera la API (`POST /admin/uploads/signature`, solo admin). Solo necesitas: `CLOUDINARY_CLOUD_NAME` (variable de la API y `PUBLIC_CLOUDINARY_CLOUD_NAME` en el build de la web, mismo valor) y los secretos `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET` en la API. Las carpetas `prometeo/products`, `prometeo/courses`, `prometeo/campaigns`, etc. se crean solas en la primera subida.

### 4. Web

```bash
PUBLIC_API_URL=https://api.<dominio> pnpm --filter @prometeo/web build
cd apps/web && pnpm exec wrangler deploy
```

`PUBLIC_API_URL` se incrusta al compilar. El `SESSION` KV que pide el adaptador se aprovisiona solo en el primer deploy.

### 5. Dominio y DNS

1. Añade el dominio a Cloudflare y apunta los nameservers.
2. Workers & Pages → `prometeo-web` → Domains: `<dominio>` y `www`. `prometeo-api` → `api.<dominio>`. Cloudflare crea los registros DNS y los certificados.
3. Resend: añade los registros SPF/DKIM/DMARC que indica para `EMAIL_FROM`.
4. Wompi: en Desarrolladores configura la URL de eventos `https://api.<dominio>/webhooks/wompi`.

### 6. CI/CD (GitHub Actions)

`.github/workflows/ci.yml`: en cada PR corre lint, typecheck, tests y build. En `push` a `main` migra la BD y despliega API y web.

Configura en GitHub → Settings (entorno `production`):

- Secrets: `CLOUDFLARE_API_TOKEN` (permiso _Workers Scripts: Edit_), `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL_DIRECT`.
- Variables: `PUBLIC_API_URL`, `PUBLIC_CLOUDINARY_CLOUD_NAME`, `PUBLIC_SITE_URL`.

Los secretos del Worker **no** pasan por CI: se cargan una vez con `wrangler secret put`.

## Documentación

- [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md): revisión de la sección de seguridad, punto por punto.
- [`docs/LAUNCH-CHECKLIST.md`](docs/LAUNCH-CHECKLIST.md): lista previa al lanzamiento (Wompi, datos de prueba, backups, Leyes 1581 y 1480).
