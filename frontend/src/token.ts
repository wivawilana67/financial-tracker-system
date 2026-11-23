// Pure helpers for Google ID tokens. Only the expiry claim is read; the server does the real check.

/** Milliseconds since epoch when the token expires, or 0 when it can't be read. */
export function tokenExpiryMs(token: string): number {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { exp } = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    return Number(exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

/** True while the token has more than `marginMs` left. */
export function isFresh(token: string | null, now: number, marginMs: number): boolean {
  return !!token && tokenExpiryMs(token) - now > marginMs;
}
