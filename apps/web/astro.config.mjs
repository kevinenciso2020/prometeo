import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Astro 7 cambió el default a 'jsx'; mantenemos el comportamiento de Astro 6.
  compressHTML: true,
  output: 'server',
  adapter: cloudflare(),
  server: { port: 4321 },
});
