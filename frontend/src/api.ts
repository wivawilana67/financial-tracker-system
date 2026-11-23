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

export interface LedgerTotal {
  ledger: string;
  total: string;
  percent_of_income: string;
  target: string;
  to_target_percent: string;
}

export interface DashboardResponse {
  month: string;
  income: string;
  ledgers: LedgerTotal[];
  expected_remaining: string;
  current_remaining: string;
}

export interface LedgerRow {
  id: number;
  version: number;
  ledger: string;
  list: string;
  type: string;
  amount: string;
  channel: string;
  cicilan: boolean;
  remaining: number | null;
  paid: boolean;
}

export interface IncomeRow {
  id: number;
  version: number;
  person: string;
  category: string;
  amount: string;
}

export interface LedgerResponse {
  month: string;
  rows: LedgerRow[];
  income: IncomeRow[];
}

export interface Candidate {
  uid: string;
  ledger: string;
  list: string;
  type: string;
  channel: string;
  amount: string;
  cicilan: boolean;
  remaining_after: number | null;
}

export interface ChangeResult {
  updated: number;
  deleted: number;
  added: number;
  skipped: string[];
  jajan_adjusted: string[];
}

export interface RolloverPlan {
  month: string;
  summary: Record<string, { updated: number; inserted: number }>;
  autodeduct_totals: Record<string, string>;
  jajan_net: Record<string, string>;
  written?: { updated: number; inserted: number };
}

export interface RolloverBody {
  month: string;
  selected: string[];
  overrides: Record<string, string>;
  income: { person: string; category: string; amount: string }[];
  jajan_base: { Wiva: string; Jane: string };
  jajan_rates: { pool: number; wiva: number; jane: number };
  wiva_channel: string;
  jane_channel: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export interface CcRow {
  id: number;
  datetime: string;
  bank: string;
  card: string;
  description: string;
  type: string;
  amount: string;
  currency: string;
  inbox: string;
  selected: boolean;
  paid: boolean;
  kind: '' | 'cicilan' | 'bulanan';
  cancelled: boolean;
  note: string;
  archived: boolean;
  version: number;
}

export const api = {
  cc: (filter: string) => request<{ filter: string; rows: CcRow[] }>(`cc?filter=${encodeURIComponent(filter)}`),
  ccUpdate: (rows: Partial<CcRow>[]) => post<{ updated: number; skipped: string[] }>('cc/update', { rows }),
  ccCleanup: () => post<{ hidden: number }>('cc/cleanup', {}),
  ccRestore: (id: number) => post<{ id: number; archived: boolean }>('cc/restore', { id }),
  ledger: (month: string, ledger?: string) =>
    request<LedgerResponse>(`ledger?month=${encodeURIComponent(month)}${ledger ? `&ledger=${ledger}` : ''}`),
  saveChanges: (body: unknown) => post<ChangeResult>('monthly/changes', body),
  markPaid: (body: unknown) => post<{ marked: number }>('monthly/paid', body),
  candidates: (month: string) => request<{ source: string; candidates: Candidate[] }>(
    `rollover/candidates?month=${encodeURIComponent(month)}`),
  rolloverPreview: (body: RolloverBody) => post<RolloverPlan>('rollover/preview', body),
  rolloverApply: (body: RolloverBody) => post<RolloverPlan>('rollover/apply', body),
  session: () => request<Session>('session'),
  healthDb: () => request<{ status: string; database: string }>('health/db'),
  dashboard: (month: string) => request<DashboardResponse>(`dashboard?month=${encodeURIComponent(month)}`),
};

/** '' when the API serves this app's environment, otherwise the message to show. */
export function envMismatch(appEnv: AppEnv, apiEnv: unknown): string {
  if (apiEnv === appEnv) return '';
  const shown = typeof apiEnv === 'string' && apiEnv ? apiEnv.toUpperCase() : 'UNKNOWN';
  return `This is the ${appEnv.toUpperCase()} app but the server is ${shown}.`;
}
