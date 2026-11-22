/** Utilidades del lado servidor para consumir la API y datos del sitio. */
import { serverFetch } from './api-server';
export const API_URL: string = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8787';
export const SITE_URL: string = (
  import.meta.env.PUBLIC_SITE_URL ?? 'http://localhost:4321'
).replace(/\/$/, '');
export const SITE_NAME = 'Prometeo';
export const SITE_TAGLINE = 'Taller de cerámica artesanal';

/** GET a la API; devuelve null si falla (la página muestra un mensaje amable). */
export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await serverFetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface Settings {
  shipping_flat_rate: number;
  free_shipping_threshold: number | null;
  contact: { email: string; phone: string; whatsapp: string; address: string; hours: string };
  social: { instagram: string; facebook: string; tiktok: string };
  legal: { terms: string; privacy: string; shipping_returns: string };
}

export const DEFAULT_SETTINGS: Settings = {
  shipping_flat_rate: 0,
  free_shipping_threshold: null,
  contact: { email: '', phone: '', whatsapp: '', address: '', hours: '' },
  social: { instagram: '', facebook: '', tiktok: '' },
  legal: { terms: '', privacy: '', shipping_returns: '' },
};

let cached: { at: number; value: Settings } | null = null;
export async function getSettings(): Promise<Settings> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const r = await apiGet<{ settings: Settings }>('/public/settings');
  const value = r?.settings ?? DEFAULT_SETTINGS;
  if (r) cached = { at: Date.now(), value };
  return value;
}

export interface ProductCardData {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice: number | null;
  stock: number;
  isUnique: boolean;
  categoryName: string | null;
  image: string | null;
}
export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface CategoryData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
}
export interface ServiceData {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number | null;
  mode: 'pago_online' | 'cotizacion';
  image?: string | null;
  images?: { url: string; alt: string | null }[];
}

/** Serializa JSON-LD evitando cerrar el <script> por accidente. */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function whatsappUrl(
  number: string,
  text = 'Hola, quisiera más información',
): string | null {
  const digits = number.replace(/\D/g, '');
  if (!digits) return null;
  const full = digits.length === 10 ? `57${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

const TZ = 'America/Bogota';
export function fmtDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: TZ,
  }).format(new Date(value));
}
export function fmtDay(value: string | Date): string {
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: TZ }).format(
    new Date(value),
  );
}
export function fmtTime(value: string | Date): string {
  return new Intl.DateTimeFormat('es-CO', { timeStyle: 'short', timeZone: TZ }).format(
    new Date(value),
  );
}

export type PaymentModeKey = 'total' | 'reserva' | 'abono' | 'lista';
export interface CourseListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  level: string | null;
  durationText: string | null;
  image: string | null;
  fromPrice: number | null;
  nextEdition: {
    id: string;
    startsAt: string | null;
    seatsLeft: number;
    price: number;
    full: boolean;
  } | null;
}
export interface PublicEdition {
  id: string;
  location: string;
  instructor: string | null;
  price: number;
  maxSeats: number;
  seatsLeft: number;
  enrollmentDeadline: string;
  allowedPaymentModes: PaymentModeKey[];
  reservationHours: number;
  depositAmount: number;
  balanceDueAt: string | null;
  open: boolean;
  full: boolean;
  sessions: { startsAt: string; endsAt: string }[];
  firstStart: string | null;
}
export interface CourseDetail {
  id: string;
  name: string;
  slug: string;
  description: string;
  level: string | null;
  durationText: string | null;
  includes: string | null;
  images: { url: string; alt: string | null }[];
  editions: PublicEdition[];
}
