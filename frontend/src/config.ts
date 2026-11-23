// Build-time settings. GitHub Actions sets them per environment; locally they come from frontend/.env.local.

export type AppEnv = 'local' | 'dev' | 'prod';

function readEnv(value: string | undefined): AppEnv {
  return value === 'dev' || value === 'prod' ? value : 'local';
}

export const APP_ENV: AppEnv = readEnv(import.meta.env.VITE_APP_ENV);
export const IS_PROD = APP_ENV === 'prod';
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
