import type { Mail } from './mailer.js';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:18px">${escape(title)}</h1>
${bodyHtml}
</td></tr></table></body></html>`;
}

function button(href: string, label: string) {
  return `<p style="margin:24px 0"><a href="${escape(href)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escape(label)}</a></p>
<p style="font-size:12px;color:#64748b;word-break:break-all">Or open this link: ${escape(href)}</p>`;
}

export function otpEmail(to: string, code: string, tenantName: string, minutes: number): Mail {
  return {
    to,
    subject: `Your ${tenantName} sign-in code: ${code}`,
    text: `Your sign-in code for ${tenantName} is ${code}.\n\nIt expires in ${minutes} minutes. If you didn't try to sign in, you can ignore this email.`,
    html: layout(`Sign in to ${tenantName}`, `<p>Your sign-in code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${escape(code)}</p>
<p style="color:#475569">It expires in ${minutes} minutes. If you didn't try to sign in, you can ignore this email.</p>`),
  };
}

export function inviteEmail(to: string, link: string, tenantName: string, inviterName: string, days: number): Mail {
  return {
    to,
    subject: `${inviterName} invited you to ${tenantName}`,
    text: `${inviterName} invited you to join ${tenantName}.\n\nSet your password and sign in: ${link}\n\nThis invitation expires in ${days} days.`,
    html: layout(`Join ${tenantName}`, `<p>${escape(inviterName)} invited you to join <strong>${escape(tenantName)}</strong>.</p>
${button(link, 'Accept invitation')}
<p style="color:#475569">This invitation expires in ${days} days.</p>`),
  };
}

export function passwordResetEmail(to: string, link: string, tenantName: string, minutes: number): Mail {
  return {
    to,
    subject: `Reset your ${tenantName} password`,
    text: `Someone asked to reset the password for your ${tenantName} account.\n\nChoose a new password: ${link}\n\nThis link expires in ${minutes} minutes and can be used once. If it wasn't you, ignore this email; your password is unchanged.`,
    html: layout('Reset your password', `<p>Someone asked to reset the password for your <strong>${escape(tenantName)}</strong> account.</p>
${button(link, 'Choose a new password')}
<p style="color:#475569">This link expires in ${minutes} minutes and can be used once. If it wasn't you, ignore this email; your password is unchanged.</p>`),
  };
}

/** A notification by email (lib/notifications.ts). */
export function notificationEmail(
  to: string,
  n: { title: string; body?: string | null; link?: string | null; from: string; mandatory: boolean; settingsLink: string },
): Mail {
  const footer = n.mandatory
    ? 'This is a security notice; it can’t be turned off.'
    : `Choose which emails you get: ${n.settingsLink}`;
  return {
    to,
    subject: `[${n.from}] ${n.title}`,
    text: `${n.title}\n\n${n.body ? `${n.body}\n\n` : ''}${n.link ? `Open: ${n.link}\n\n` : ''}${footer}`,
    html: layout(n.title, `${n.body ? `<p>${escape(n.body)}</p>` : ''}
${n.link ? button(n.link, 'Open') : ''}
<p style="font-size:12px;color:#64748b;margin-top:24px">${n.mandatory ? escape(footer) : `<a href="${escape(n.settingsLink)}" style="color:#64748b">Choose which emails you get</a>`}</p>`),
  };
}
