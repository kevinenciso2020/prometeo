import { toWompiCents, wompiIntegritySignature } from '@prometeo/shared';
import type { Bindings } from '../env';

export interface CheckoutParams {
  reference: string;
  /** Monto en pesos COP (entero). Se convierte a centavos aquí. */
  amount: number;
  redirectUrl: string;
  email?: string;
  fullName?: string;
  phone?: string;
}

export interface WompiCheckout {
  url: string;
  amountInCents: number;
  signature: string;
}

/**
 * Web Checkout de Wompi: redirección a checkout.wompi.co con firma de integridad.
 * La integridad impide que el cliente altere monto o referencia. El resultado real lo da el webhook.
 */
export async function buildWompiCheckout(env: Bindings, p: CheckoutParams): Promise<WompiCheckout> {
  const amountInCents = toWompiCents(p.amount);
  const signature = await wompiIntegritySignature({
    reference: p.reference,
    amountInCents,
    secret: env.WOMPI_INTEGRITY_SECRET,
  });
  const q = new URLSearchParams({
    'public-key': env.WOMPI_PUBLIC_KEY,
    currency: 'COP',
    'amount-in-cents': String(amountInCents),
    reference: p.reference,
    'signature:integrity': signature,
    'redirect-url': p.redirectUrl,
  });
  if (p.email) q.set('customer-data:email', p.email);
  if (p.fullName) q.set('customer-data:full-name', p.fullName);
  if (p.phone) q.set('customer-data:phone-number', p.phone.replace(/\D/g, ''));
  return { url: `https://checkout.wompi.co/p/?${q.toString()}`, amountInCents, signature };
}
