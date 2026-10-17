import type { Mail } from './mailer.js';

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:'IBM Plex Sans',-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2532">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #dfe3e9;border-radius:8px">
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:18px">${escape(title)}</h1>
${bodyHtml}
</td></tr></table></body></html>`;
}

function button(href: string, label: string) {
  return `<p style="margin:24px 0"><a href="${escape(href)}" style="display:inline-block;background:#0b7a6a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escape(label)}</a></p>
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

/** Confirming the email address of someone signing up (routes/signup.ts) */
export function signupConfirmEmail(to: string, link: string, organization: string, hours: number): Mail {
  return {
    to,
    subject: `Confirm your email to create ${organization}`,
    text: `Confirm your email address to create ${organization}: ${link}\n\nThe link works for ${hours} hours. If you didn't sign up, ignore this email; nothing is created.`,
    html: layout(`Create ${organization}`, `<p>Confirm your email address and we'll set up <strong>${escape(organization)}</strong>.</p>
${button(link, 'Confirm and create')}
<p style="color:#475569">The link works for ${hours} hours. If you didn't sign up, ignore this email; nothing is created.</p>`),
  };
}

/** The organization someone signed up for is ready (lib/provisioning.ts) */
export function organizationReadyEmail(to: string, link: string, organization: string): Mail {
  return {
    to,
    subject: `${organization} is ready`,
    text: `${organization} is set up. Sign in with the email and password you chose: ${link}`,
    html: layout(`${organization} is ready`, `<p><strong>${escape(organization)}</strong> is set up. Sign in with the email and password you chose.</p>
${button(link, `Sign in to ${organization}`)}`),
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
