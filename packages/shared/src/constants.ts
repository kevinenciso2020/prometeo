export const ROLES = ['CLIENTE', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ADMIN_ROLES: readonly Role[] = ['ADMIN', 'SUPER_ADMIN'];

export const AUTH_TOKEN_TYPES = ['verify_email', 'reset_password'] as const;
export type AuthTokenType = (typeof AUTH_TOKEN_TYPES)[number];

/** Duración de los tokens (en segundos). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const VERIFY_EMAIL_TTL_SECONDS = 24 * 60 * 60;
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

export const ACCESS_COOKIE = 'prometeo_at';
export const REFRESH_COOKIE = 'prometeo_rt';

export const CURRENCY = 'COP' as const;
export const TIMEZONE = 'America/Bogota' as const;
