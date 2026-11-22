import { PAYMENT_MODE_LABELS, formatCop, type PaymentMode } from '@prometeo/shared';
import { fmtDate, fmtDateTime } from './dates';
import { escapeHtml } from './emails';
import type { Email } from './mailer';

export interface EnrollmentEmailCtx {
  to: string;
  name: string;
  courseName: string;
  location: string;
  firstSession: Date | null;
  mode: PaymentMode;
  total: number;
  paid: number;
  reservedUntil: Date | null;
  balanceDueAt: Date | null;
  statusUrl: string;
}

const pending = (c: EnrollmentEmailCtx) => Math.max(0, c.total - c.paid);

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f5f5f5;font-family:Georgia,serif;color:#111">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<h1 style="font-size:22px;margin:0 0 16px">Prometeo · Taller de cerámica</h1>
<div style="background:#fff;border:2px solid #111;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.5">
<h2 style="margin-top:0;font-family:Georgia,serif">${title}</h2>${body}</div>
<p style="font-size:12px;color:#6b6b6b">Si no reconoces este mensaje, puedes ignorarlo.</p></div></body></html>`;
}

const btn = (url: string, label: string) =>
  `<p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;text-decoration:none">${label}</a></p><p style="font-size:13px;color:#6b6b6b">O copia este enlace: ${url}</p>`;

function build(
  c: EnrollmentEmailCtx,
  subject: string,
  title: string,
  lines: string[],
  cta?: string,
): Email {
  const when = c.firstSession
    ? `<p><strong>Inicio:</strong> ${escapeHtml(fmtDateTime(c.firstSession))}<br><strong>Lugar:</strong> ${escapeHtml(c.location)}</p>`
    : '';
  const html = layout(
    title,
    `<p>Hola ${escapeHtml(c.name)},</p>${lines.map((l) => `<p>${l}</p>`).join('')}<p><strong>${escapeHtml(c.courseName)}</strong></p>${when}${cta ? btn(c.statusUrl, cta) : ''}`,
  );
  const text = [
    `Hola ${c.name},`,
    ...lines.map((l) => l.replace(/<[^>]+>/g, '')),
    c.courseName,
    c.firstSession ? `Inicio: ${fmtDateTime(c.firstSession)} · ${c.location}` : '',
    cta ? `${cta}: ${c.statusUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { to: c.to, subject, html, text };
}

export function enrollmentReceived(c: EnrollmentEmailCtx): Email {
  const until = c.reservedUntil ? fmtDateTime(c.reservedUntil) : '';
  const lines: Record<PaymentMode, string[]> = {
    total: [
      `Recibimos tu inscripción (${PAYMENT_MODE_LABELS.total}). Tu cupo está retenido hasta ${until}. Se confirma cuando se apruebe el pago de ${formatCop(c.total)}.`,
    ],
    reserva: [
      `Reservamos tu cupo hasta ${until}. Para conservarlo debes pagar ${formatCop(c.total)} antes de esa fecha; si no, se libera automáticamente.`,
    ],
    abono: [
      `Recibimos tu inscripción (abono + saldo). Tu cupo está retenido hasta ${until} mientras realizas el abono. El saldo se paga antes de ${c.balanceDueAt ? fmtDate(c.balanceDueAt) : 'la fecha acordada'}.`,
    ],
    lista: [
      'Quedaste en la lista del curso, sin cupo reservado. Te avisaremos por correo si se libera un cupo; solo se asegura cuando pagas y aún hay disponibles.',
    ],
  };
  return build(
    c,
    'Recibimos tu inscripción — Prometeo',
    'Inscripción recibida',
    lines[c.mode],
    'Ver mi inscripción',
  );
}

export function reservationReminder(c: EnrollmentEmailCtx): Email {
  return build(
    c,
    'Tu reserva está por vencer — Prometeo',
    'Tu reserva vence pronto',
    [
      `Tu cupo está reservado hasta ${c.reservedUntil ? fmtDateTime(c.reservedUntil) : 'pronto'}. Si no pagas a tiempo, se liberará para otra persona.`,
    ],
    'Ver mi inscripción',
  );
}

export function reservationExpired(c: EnrollmentEmailCtx): Email {
  return build(
    c,
    'Tu reserva venció — Prometeo',
    'Reserva vencida',
    [
      'Tu reserva venció y el cupo fue liberado. Si aún te interesa, puedes inscribirte de nuevo mientras haya cupos.',
    ],
    'Ver el curso',
  );
}

export function depositReceived(c: EnrollmentEmailCtx): Email {
  return build(
    c,
    'Recibimos tu pago — Prometeo',
    'Abono recibido',
    [
      `Recibimos tu pago. Total pagado: ${formatCop(c.paid)}. Saldo pendiente: <strong>${formatCop(pending(c))}</strong>${c.balanceDueAt ? ` (antes del ${fmtDate(c.balanceDueAt)})` : ''}. Tu cupo está asegurado.`,
    ],
    'Ver mi inscripción',
  );
}

export function paymentComplete(c: EnrollmentEmailCtx): Email {
  return build(
    c,
    'Pago completo — Prometeo',
    '¡Tu cupo está confirmado!',
    [`Recibimos el pago completo (${formatCop(c.total)}). Tu cupo está confirmado. ¡Te esperamos!`],
    'Ver mi inscripción',
  );
}

export function balanceReminder(c: EnrollmentEmailCtx): Email {
  return build(
    c,
    'Recordatorio de saldo — Prometeo',
    'Saldo pendiente',
    [
      `Tienes un saldo pendiente de <strong>${formatCop(pending(c))}</strong>${c.balanceDueAt ? ` que vence el ${fmtDate(c.balanceDueAt)}` : ''}. Puedes pagarlo en línea o en efectivo en el taller.`,
    ],
    'Ver mi inscripción',
  );
}

export function seatFreed(c: EnrollmentEmailCtx): Email {
  return build(
    c,
    '¡Se liberó un cupo! — Prometeo',
    'Hay un cupo disponible',
    [
      'Se liberó un cupo en el curso en el que estabas en lista. Asegúralo cuanto antes: se entrega a quien pague primero.',
    ],
    'Asegurar mi cupo',
  );
}

export function courseReminder(c: EnrollmentEmailCtx, sessionStart: Date): Email {
  return build(
    { ...c, firstSession: sessionStart },
    'Mañana es tu clase — Prometeo',
    'Te esperamos mañana',
    [
      'Te recordamos que tu clase es mañana. Llega unos minutos antes y usa ropa cómoda que pueda ensuciarse.',
    ],
    'Ver detalles',
  );
}

export function adminNewEnrollment(to: string, c: EnrollmentEmailCtx, contactEmail: string): Email {
  const text = `Nueva inscripción\n\nCurso: ${c.courseName}\nPersona: ${c.name} <${contactEmail}>\nModalidad: ${PAYMENT_MODE_LABELS[c.mode]}\nTotal: ${formatCop(c.total)}`;
  return {
    to,
    subject: `Nueva inscripción: ${c.courseName}`,
    text,
    html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
  };
}
