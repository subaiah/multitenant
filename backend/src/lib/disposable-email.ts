/**
 * Throwaway email services, refused at sign-up (SIGNUP_BLOCK_DISPOSABLE).
 * A short list of the most used ones; add more with SIGNUP_BLOCKED_EMAIL_DOMAINS.
 * A subdomain of a listed domain is refused too.
 */
import { config } from '../config/env.js';

const DISPOSABLE = [
  '10minutemail.com', '20minutemail.com', 'anonaddy.me', 'burnermail.io', 'byom.de', 'discard.email',
  'dispostable.com', 'dropmail.me', 'emailondeck.com', 'fakeinbox.com', 'getairmail.com', 'getnada.com',
  'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com', 'incognitomail.org',
  'mail.tm', 'mail-temp.com', 'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailinator.net',
  'mailnesia.com', 'mailpoof.com', 'mintemail.com', 'mohmal.com', 'moakt.com', 'mytemp.email',
  'nada.email', 'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org',
  'tempail.com', 'tempmail.com', 'tempmail.dev', 'tempmail.net', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'tmail.ws', 'tmpmail.net', 'tmpmail.org', 'trashmail.com', 'trashmail.de',
  'trashmail.net', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
];

/** Whether sign-up should refuse this address */
export function isBlockedEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const blocked = [...(config.signupBlockDisposable ? DISPOSABLE : []), ...config.signupBlockedDomains];
  return blocked.some((d) => domain === d || domain.endsWith(`.${d}`));
}
