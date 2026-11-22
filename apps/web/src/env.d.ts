/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: {
      id: string;
      email: string;
      name: string;
      role: 'CLIENTE' | 'ADMIN' | 'SUPER_ADMIN';
    };
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_API_URL?: string;
  readonly PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
}
