import type { Db } from '@prometeo/db';
import type { Role } from '@prometeo/shared';
import type { Mailer } from './lib/mailer';

export interface Bindings {
  // Secretos
  DATABASE_URL: string;
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  // Variables
  ENVIRONMENT: 'development' | 'production' | 'test';
  WEB_ORIGIN: string;
  WEB_URL: string;
  EMAIL_FROM: string;
  COOKIE_DOMAIN?: string;
  // Rate limiting
  RL_AUTH?: RateLimit;
}

export interface AuthUser {
  id: string;
  role: Role;
}

export interface Variables {
  db: Db;
  mailer: Mailer;
  user?: AuthUser;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
