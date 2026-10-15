import { appendFile } from 'node:fs/promises';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let smtp: Transporter | undefined;

/**
 * Send an email with the configured transport:
 * - smtp: real delivery via SMTP_URL (works with SES, SendGrid, Postmark, Gmail, …)
 * - log:  printed to stdout (local development)
 * - file: appended as a JSON line to MAIL_OUTBOX_FILE (tests read it)
 */
export async function sendMail(mail: Mail): Promise<void> {
  switch (config.email.transport) {
    case 'smtp':
      smtp ??= nodemailer.createTransport(config.email.smtpUrl);
      await smtp.sendMail({ from: config.email.from, ...mail });
      return;
    case 'file':
      await appendFile(config.email.outboxFile!, JSON.stringify({ ...mail, sentAt: new Date().toISOString() }) + '\n');
      return;
    default:
      console.log(`\n📧 Email to ${mail.to}: ${mail.subject}\n${mail.text}\n`);
  }
}

/** Warn loudly when emails would not leave the server in production. */
export function emailDeliveryWarning(): string | null {
  if (config.nodeEnv === 'production' && config.email.transport !== 'smtp') {
    return `EMAIL_TRANSPORT=${config.email.transport}: one-time codes, invitations and password resets will NOT be delivered. Set EMAIL_TRANSPORT=smtp and SMTP_URL.`;
  }
  return null;
}
