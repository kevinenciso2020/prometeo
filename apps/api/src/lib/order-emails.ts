import { ORDER_STATUS_LABELS, formatCop, type OrderStatus } from '@prometeo/shared';
import { escapeHtml } from './emails';
import type { Email } from './mailer';

export interface OrderEmailCtx {
  to: string;
  name: string;
  number: number;
  items: { name: string; quantity: number; lineTotal: number }[];
  subtotal: number;
  shipping: number;
  total: number;
  statusUrl: string;
  trackingNumber?: string | null;
  status?: OrderStatus;
}

export const orderCode = (n: number) => `PR-${String(n).padStart(6, '0')}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f5f5f5;font-family:Georgia,serif;color:#111">
<div style="max-width:520px;margin:0 auto;padding:32px 24px"><h1 style="font-size:22px;margin:0 0 16px">Prometeo · Taller de cerámica</h1>
<div style="background:#fff;border:2px solid #111;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.5">
<h2 style="margin-top:0;font-family:Georgia,serif">${title}</h2>${body}</div>
<p style="font-size:12px;color:#6b6b6b">Si no reconoces este mensaje, puedes ignorarlo.</p></div></body></html>`;
}

function table(c: OrderEmailCtx): string {
  const rows = c.items
    .map(
      (i) =>
        `<tr><td style="padding:4px 0">${escapeHtml(i.name)} × ${i.quantity}</td><td style="text-align:right">${formatCop(i.lineTotal)}</td></tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0">${rows}
<tr><td style="border-top:1px solid #ddd;padding-top:6px">Envío</td><td style="border-top:1px solid #ddd;text-align:right">${c.shipping === 0 ? 'Gratis' : formatCop(c.shipping)}</td></tr>
<tr><td><strong>Total</strong></td><td style="text-align:right"><strong>${formatCop(c.total)}</strong></td></tr></table>`;
}

const btn = (url: string, label: string) =>
  `<p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;text-decoration:none">${label}</a></p><p style="font-size:13px;color:#6b6b6b">O copia este enlace: ${url}</p>`;

function textOf(c: OrderEmailCtx, intro: string, cta: string): string {
  const lines = c.items
    .map((i) => `- ${i.name} × ${i.quantity}: ${formatCop(i.lineTotal)}`)
    .join('\n');
  return `Hola ${c.name},\n\n${intro}\n\nPedido ${orderCode(c.number)}\n${lines}\nEnvío: ${c.shipping === 0 ? 'Gratis' : formatCop(c.shipping)}\nTotal: ${formatCop(c.total)}\n\n${cta}: ${c.statusUrl}`;
}

function build(
  c: OrderEmailCtx,
  subject: string,
  title: string,
  intro: string,
  cta: string,
  extra = '',
): Email {
  return {
    to: c.to,
    subject,
    text: textOf(c, intro, cta) + (extra ? `\n\n${extra.replace(/<[^>]+>/g, '')}` : ''),
    html: layout(
      title,
      `<p>Hola ${escapeHtml(c.name)},</p><p>${intro}</p><p><strong>Pedido ${orderCode(c.number)}</strong></p>${table(c)}${extra}${btn(c.statusUrl, cta)}`,
    ),
  };
}

export const orderReceived = (c: OrderEmailCtx) =>
  build(
    c,
    `Recibimos tu pedido ${orderCode(c.number)} — Prometeo`,
    'Pedido recibido',
    'Recibimos tu pedido. Se confirma cuando se apruebe el pago; si aún no pagaste puedes hacerlo desde el enlace.',
    'Ver mi pedido',
  );

export const orderPaid = (c: OrderEmailCtx) =>
  build(
    c,
    `Pago aprobado — pedido ${orderCode(c.number)}`,
    '¡Pago aprobado!',
    'Recibimos tu pago. Ya estamos preparando tu pedido.',
    'Ver mi pedido',
  );

export const paymentRejected = (c: OrderEmailCtx) =>
  build(
    c,
    `Tu pago no pudo completarse — pedido ${orderCode(c.number)}`,
    'Pago no completado',
    'Tu pago fue rechazado o no pudo completarse. No se te cobró. Puedes intentarlo de nuevo con otro medio de pago.',
    'Reintentar el pago',
  );

export const orderShipped = (c: OrderEmailCtx) =>
  build(
    c,
    `Tu pedido ${orderCode(c.number)} va en camino`,
    'Pedido enviado',
    'Tu pedido fue despachado.',
    'Ver mi pedido',
    c.trackingNumber
      ? `<p><strong>Número de guía:</strong> ${escapeHtml(c.trackingNumber)}</p>`
      : '',
  );

export function adminNewOrder(to: string, c: OrderEmailCtx, contactEmail: string): Email {
  const text = `Nuevo pedido pagado ${orderCode(c.number)}\nCliente: ${c.name} <${contactEmail}>\nTotal: ${formatCop(c.total)}\n${c.items.map((i) => `- ${i.name} × ${i.quantity}`).join('\n')}`;
  return {
    to,
    subject: `Nuevo pedido ${orderCode(c.number)} (${formatCop(c.total)})`,
    text,
    html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
  };
}

export function adminReview(to: string, subject: string, detail: string): Email {
  return {
    to,
    subject: `⚠ Requiere revisión: ${subject}`,
    text: detail,
    html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(detail)}</pre>`,
  };
}

export const statusLabel = (s: OrderStatus) => ORDER_STATUS_LABELS[s];
