import { describe, expect, it } from 'vitest';
import { connectRequestOf } from './ConnectApplication';

describe('connectRequestOf', () => {
  it('reads the request the application sent', () => {
    const params = new URLSearchParams({
      app_url: 'https://hearth.example.com',
      redirect_uri: 'https://hearth.example.com/hub/connected',
      code_challenge: 'x'.repeat(43),
      state: 'abc',
      scope: 'organizations.read  members.read',
    });
    expect(connectRequestOf(params)).toEqual({
      appUrl: 'https://hearth.example.com',
      redirectUri: 'https://hearth.example.com/hub/connected',
      codeChallenge: 'x'.repeat(43),
      state: 'abc',
      scopes: ['organizations.read', 'members.read'],
    });
  });

  it('leaves out what was not sent', () => {
    expect(connectRequestOf(new URLSearchParams({ app_url: 'https://a.example.com' }))).toEqual({
      appUrl: 'https://a.example.com',
      redirectUri: '',
      codeChallenge: '',
      scopes: [],
    });
  });
});
