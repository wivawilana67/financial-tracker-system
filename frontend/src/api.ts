// Calls to the Django API on the same address (/api/...). The ID token goes in the Authorization header.

import { clearIdToken, getIdToken } from './auth';
import type { AppEnv } from './config';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface Session {
  email: string;
  env: AppEnv;
  month: string;
}

let onSessionExpired: () => void = () => {};

/** The app registers what happens when the API says the sign-in is no longer valid. */
export function onUnauthorized(handler: () => void): void {
  onSessionExpired = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getIdToken();
  if (!token) {
    onSessionExpired();
    throw new ApiError('Sign in again', 401);
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`/api/${path}`, { ...init, headers, cache: 'no-store' });
  } catch (err) {
    console.error('[api] network error', path, err);
    throw new ApiError('No connection to the server', 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    clearIdToken();
    onSessionExpired();
  }
  if (!res.ok) {
    console.error('[api] request failed', path, res.status, body.error);
    throw new ApiError(body.error || `Server error ${res.status}`, res.status);
  }
  return body as T;
}

export const api = {
  session: () => request<Session>('session'),
  healthDb: () => request<{ status: string; database: string }>('health/db'),
};

/** '' when the API serves this app's environment, otherwise the message to show. */
export function envMismatch(appEnv: AppEnv, apiEnv: unknown): string {
  if (apiEnv === appEnv) return '';
  const shown = typeof apiEnv === 'string' && apiEnv ? apiEnv.toUpperCase() : 'UNKNOWN';
  return `This is the ${appEnv.toUpperCase()} app but the server is ${shown}.`;
}
