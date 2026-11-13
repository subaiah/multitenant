import { describe, expect, it } from 'vitest';
import { passwordRules, type PasswordPolicy } from './password-policy';

const passes = (policy: PasswordPolicy, password: string) => passwordRules(policy).every((r) => r.test(password));

describe('passwordRules', () => {
  it('STANDARD asks only for eight characters', () => {
    expect(passwordRules('STANDARD')).toHaveLength(1);
    expect(passes('STANDARD', 'abcdefgh')).toBe(true);
    expect(passes('STANDARD', 'abcdefg')).toBe(false);
  });

  it('STRONG asks for ten characters, both cases and a number', () => {
    expect(passes('STRONG', 'Abcdefgh12')).toBe(true);
    expect(passes('STRONG', 'Abcdefg12')).toBe(false); // nine
    expect(passes('STRONG', 'abcdefgh12')).toBe(false); // no capital
    expect(passes('STRONG', 'Abcdefghij')).toBe(false); // no number
  });

  it('VERY_STRONG asks for twelve characters and a symbol as well', () => {
    expect(passes('VERY_STRONG', 'Abcdefghi12!')).toBe(true);
    expect(passes('VERY_STRONG', 'Abcdefghij12')).toBe(false); // no symbol
    expect(passes('VERY_STRONG', 'Abcdefgh12!')).toBe(false); // eleven
  });

  it('says which rule a password fails', () => {
    const failed = passwordRules('VERY_STRONG').filter((r) => !r.test('abcdefghijkl')).map((r) => r.label);
    expect(failed).toEqual(['Upper- and lower-case letters', 'A number', 'A symbol']);
  });
});
