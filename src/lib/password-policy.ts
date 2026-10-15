/**
 * Client-side mirror of backend/src/utils/auth.ts checkPasswordPolicy, for
 * live feedback while typing. The server is the source of truth.
 */
export type PasswordPolicy = 'STANDARD' | 'STRONG' | 'VERY_STRONG';

export function passwordRules(policy: PasswordPolicy): { label: string; test: (p: string) => boolean }[] {
  const min = policy === 'VERY_STRONG' ? 12 : policy === 'STRONG' ? 10 : 8;
  const rules = [{ label: `At least ${min} characters`, test: (p: string) => p.length >= min }];
  if (policy !== 'STANDARD') {
    rules.push({ label: 'Upper- and lower-case letters', test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) });
    rules.push({ label: 'A number', test: (p) => /\d/.test(p) });
  }
  if (policy === 'VERY_STRONG') rules.push({ label: 'A symbol', test: (p) => /[^A-Za-z0-9]/.test(p) });
  return rules;
}
