/**
 * Opening a notification's link: a path in this app, or (an external
 * application's notification) a full address on that application's own
 * host, checked by the platform when it was sent.
 */
export function openLink(link: string, navigate: (to: string) => void): void {
  if (/^https?:\/\//.test(link)) window.open(link, '_blank', 'noopener,noreferrer');
  else navigate(link);
}
