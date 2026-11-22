import type { Email } from './mailer';

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f5f5f5;font-family:Georgia,serif;color:#111111">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<h1 style="font-size:22px;color:#111111;margin:0 0 16px">Prometeo · Taller de cerámica</h1>
<div style="background:#fff;border-radius:8px;padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.5">
<h2 style="margin-top:0;font-family:Georgia,serif">${title}</h2>${body}</div>
<p style="font-size:12px;color:#6b6b6b">Si no solicitaste este correo, puedes ignorarlo.</p>
</div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p><a href="${url}" style="display:inline-block;background:#111111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${label}</a></p>
<p style="font-size:13px;color:#6b6b6b">O copia este enlace: ${url}</p>`;
}

export function verifyEmailMessage(to: string, name: string, url: string): Email {
  return {
    to,
    subject: 'Verifica tu correo — Prometeo',
    html: layout(
      'Verifica tu correo',
      `<p>Hola ${escapeHtml(name)}, confirma tu correo para activar tu cuenta.</p>${button(url, 'Verificar correo')}<p>El enlace vence en 24 horas.</p>`,
    ),
    text: `Hola ${name}, verifica tu correo en: ${url} (vence en 24 horas).`,
  };
}

export function resetPasswordMessage(to: string, name: string, url: string): Email {
  return {
    to,
    subject: 'Recupera tu contraseña — Prometeo',
    html: layout(
      'Recupera tu contraseña',
      `<p>Hola ${escapeHtml(name)}, usa este enlace para elegir una nueva contraseña.</p>${button(url, 'Cambiar contraseña')}<p>El enlace vence en 1 hora y solo funciona una vez.</p>`,
    ),
    text: `Hola ${name}, cambia tu contraseña en: ${url} (vence en 1 hora).`,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
