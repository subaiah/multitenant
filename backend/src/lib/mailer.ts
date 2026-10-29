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

/** An email failure in a sentence an administrator can act on */
export function describeMailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string; response?: string };
  const host = smtpSettings()?.host ?? 'the mail server';
  if (e.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(e.message ?? '')) return `The mail server ${host} could not be found. Check SMTP_URL.`;
  if (e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || /ECONNREFUSED|ETIMEDOUT/.test(e.message ?? '')) {
    return `Could not connect to ${host}. Check SMTP_URL's host and port, and that this server may connect out on that port.`;
  }
  if (e.code === 'EAUTH' || e.responseCode === 535) return `${host} refused the username or password in SMTP_URL.`;
  return (e.response ?? e.message ?? String(err)).slice(0, 300);
}

/** Where email goes, without the password (for the settings page) */
export function smtpSettings(): { host: string; port: number; secure: boolean; user: string | null } | null {
  if (config.email.transport !== 'smtp' || !config.email.smtpUrl) return null;
  try {
    const u = new URL(config.email.smtpUrl);
    const secure = u.protocol === 'smtps:';
    return { host: u.hostname, port: Number(u.port) || (secure ? 465 : 587), secure, user: u.username ? decodeURIComponent(u.username) : null };
  } catch {
    return null;
  }
}

export function emailSetup() {
  return { transport: config.email.transport, from: config.email.from, smtp: smtpSettings() };
}
