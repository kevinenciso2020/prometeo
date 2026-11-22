/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: {
      id: string;
      email: string;
      name: string;
      role: 'CLIENTE' | 'ADMIN' | 'SUPER_ADMIN';
    };
    /** Memo por request de las campañas activas (ver lib/campaigns.ts). */
    campaigns?: Promise<unknown[]>;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_API_URL?: string;
  readonly PUBLIC_SITE_URL?: string;
  readonly PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
}
