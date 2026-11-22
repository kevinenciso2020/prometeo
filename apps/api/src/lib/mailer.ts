import type { Bindings } from '../env';

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Resend vía fetch (compatible con Workers). */
export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(email) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
      });
      if (!res.ok) {
        // No se registra el cuerpo del correo (datos personales), solo el estado.
        console.error(`[mailer] Resend respondió ${res.status}`);
        throw new Error('No se pudo enviar el correo');
      }
    },
  };
}

/** Sin RESEND_API_KEY (desarrollo): imprime el correo en consola. */
export function createConsoleMailer(): Mailer {
  return {
    async send(email) {
      console.log(`\n[mailer:dev] Para: ${email.to}\nAsunto: ${email.subject}\n${email.text}\n`);
    },
  };
}

export function mailerFromEnv(env: Bindings): Mailer {
  return env.RESEND_API_KEY
    ? createResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM)
    : createConsoleMailer();
}
