import type { Db } from '@prometeo/db';
import type { Role } from '@prometeo/shared';
import type { CloudinaryClient } from './lib/cloudinary';
import type { Mailer } from './lib/mailer';
import type { PoolOpener } from './lib/tx';

export interface Bindings {
  // Secretos
  DATABASE_URL: string;
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  WOMPI_INTEGRITY_SECRET: string;
  WOMPI_EVENTS_SECRET: string;
  // Variables
  ENVIRONMENT: 'development' | 'production' | 'test';
  WEB_ORIGIN: string;
  WEB_URL: string;
  EMAIL_FROM: string;
  COOKIE_DOMAIN?: string;
  CLOUDINARY_CLOUD_NAME: string;
  /** Llave pública de Wompi (pub_test_… en sandbox, pub_prod_… en producción). No es secreta. */
  WOMPI_PUBLIC_KEY: string;
  // Rate limiting
  RL_AUTH?: RateLimit;
  RL_PUBLIC?: RateLimit;
  RL_WEBHOOK?: RateLimit;
  RL_TRACK?: RateLimit;
}

export interface AuthUser {
  id: string;
  role: Role;
}

export interface Variables {
  db: Db;
  mailer: Mailer;
  openPool: PoolOpener;
  cloudinary: CloudinaryClient;
  user?: AuthUser;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
