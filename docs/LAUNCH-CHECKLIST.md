# Checklist de lanzamiento

Marca cada ítem antes de abrir al público.

## Infraestructura

- [ ] Neon: proyecto de **producción** separado del de pruebas; migraciones aplicadas con `pnpm db:migrate:ci`.
- [ ] Neon: confirmar ventana de _restore_ (point-in-time) del plan y probar una restauración a una rama.
- [ ] Neon: backup lógico adicional programado (p. ej. `pg_dump` semanal a almacenamiento propio) y probado.
- [ ] Secretos cargados con `wrangler secret put` (ver README); ninguno en git ni en `wrangler.toml`.
- [ ] `ENVIRONMENT=production`, `WEB_ORIGIN`, `WEB_URL`, `COOKIE_DOMAIN=.<dominio>` correctos (cookies `Secure`, CORS, Origin).
- [ ] DNS, certificados, `www` → apex (o viceversa) y `api.<dominio>` activos. HSTS solo después de confirmar HTTPS estable.
- [ ] Resend: dominio verificado (SPF/DKIM/DMARC) y correo de prueba entregado a bandeja (no spam).
- [ ] Web compilada con `PUBLIC_API_URL`, `PUBLIC_SITE_URL` y `PUBLIC_CLOUDINARY_CLOUD_NAME` de producción; subir una imagen de prueba desde el panel y verla en la tienda.
- [ ] Cron triggers visibles en el dashboard y un ciclo observado con `wrangler tail`.
- [ ] Monitoreo de errores/uptime configurado (p. ej. Sentry o Cloudflare Logs + alerta de uptime en `/health`).

## Wompi (de sandbox a producción)

- [ ] Cuenta Wompi aprobada para producción.
- [ ] `WOMPI_PUBLIC_KEY` = `pub_prod_…` (wrangler.toml); `WOMPI_INTEGRITY_SECRET` y `WOMPI_EVENTS_SECRET` de producción (secretos).
- [ ] URL de eventos de producción: `https://api.<dominio>/webhooks/wompi`.
- [ ] Hacer **una compra real de monto mínimo** y comprobar: pedido → pagado, correo, webhook idempotente (reenviar el evento no duplica), y reembolsarla.
- [ ] Probar un pago rechazado y uno abandonado.

## Datos

- [ ] Borrar datos de prueba/demo: pedidos, inscripciones, pagos, cotizaciones, cupones, campañas y productos/cursos demo (o dejarlos en `borrador`).
- [ ] No ejecutar `db:seed` con datos demo en producción; crear solo el admin inicial y **cambiar su clave**.
- [ ] Revisar usuarios admin: solo los necesarios, con correo verificado; sin cuentas de prueba.
- [ ] Ajustes del sitio completos: contacto, WhatsApp, redes, envío (tarifa/umbral).

## Legal (Colombia)

> Los textos incluidos en `apps/web/src/lib/legal-defaults.ts` son una **plantilla**. Un abogado debe revisarlos y completarlos (razón social, NIT, dirección, correo de habeas data) y luego publicarlos en Admin → Ajustes → Legal.

- [ ] **Ley 1581 de 2012 (habeas data):** política de privacidad publicada con responsable, finalidades, derechos del titular y canal de reclamos. Los formularios de registro, checkout, inscripción y cotización exigen el checkbox de autorización (`acceptDataPolicy`, validado también en el servidor).
- [ ] Inscripción en el Registro Nacional de Bases de Datos (RNBD) si aplica según el tamaño de la empresa.
- [ ] **Ley 1480 de 2011 (consumidor):** política de envíos y devoluciones con **derecho de retracto** (5 días hábiles, compras a distancia; excepciones) y **garantía legal** publicada; el checkout exige `acceptTerms`.
- [ ] Datos del proveedor visibles (razón social, NIT, dirección, contacto) y precios con IVA según corresponda.
- [ ] Términos y condiciones publicados.

## Calidad

- [ ] Lighthouse (móvil) en `/`, `/tienda`, un producto y `/checkout`: apuntar a Rendimiento ≥ 90, Accesibilidad ≥ 95, SEO ≥ 95, Buenas prácticas ≥ 95. `npx lighthouse https://<dominio> --view`.
- [ ] Revisar con teclado y lector de pantalla: formularios de checkout/inscripción, foco visible, contraste.
- [ ] Páginas 404 y 500 verificadas.
- [ ] `sitemap.xml` y `robots.txt` correctos; `/admin` con `noindex`.
- [ ] Cabeceras: comprobar en https://securityheaders.com (CSP, HSTS, etc.).
