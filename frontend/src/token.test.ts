import { describe, expect, it } from 'vitest';

import { envMismatch } from './api';
import { isFresh, tokenExpiryMs } from './token';

function fakeToken(payload: object): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${b64}.signature`;
}

describe('tokenExpiryMs', () => {
  it('reads exp in milliseconds', () => {
    expect(tokenExpiryMs(fakeToken({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });
  it('returns 0 for unreadable tokens', () => {
    expect(tokenExpiryMs('not-a-jwt')).toBe(0);
    expect(tokenExpiryMs(fakeToken({}))).toBe(0);
  });
});

describe('isFresh', () => {
  const token = fakeToken({ exp: 1000 });
  it('is fresh only with more than the margin left', () => {
    expect(isFresh(token, 800_000, 120_000)).toBe(true);
    expect(isFresh(token, 900_000, 120_000)).toBe(false);
    expect(isFresh(null, 0, 0)).toBe(false);
  });
});

describe('envMismatch', () => {
  it('accepts the same environment', () => {
    expect(envMismatch('dev', 'dev')).toBe('');
  });
  it('names both sides when they differ', () => {
    expect(envMismatch('prod', 'dev')).toBe('This is the PROD app but the server is DEV.');
    expect(envMismatch('dev', undefined)).toBe('This is the DEV app but the server is UNKNOWN.');
  });
});
