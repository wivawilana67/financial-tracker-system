// Google Identity Services: the sign-in button, the one-tap prompt and the ID token (memory only, never stored).

import { isFresh } from './token';

const GIS_POLL_MS = 100;
const GIS_TIMEOUT_MS = 10_000;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

interface GoogleId {
  initialize(options: Record<string, unknown>): void;
  renderButton(el: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

let idToken: string | null = null;
let googleId: GoogleId | null = null;

/** The token while it has at least two minutes left, otherwise null (the user must sign in again). */
export function getIdToken(): string | null {
  if (!isFresh(idToken, Date.now(), REFRESH_MARGIN_MS)) idToken = null;
  return idToken;
}

export function clearIdToken(): void {
  idToken = null;
}

/** Waits for the Google script, then sets up one-tap. Resolves false if it never loads. */
export function initAuth(clientId: string, onSignedIn: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const id = window.google?.accounts?.id;
      if (id) {
        clearInterval(timer);
        googleId = id;
        id.initialize({
          client_id: clientId,
          callback: (response: { credential?: string }) => {
            if (!response?.credential) {
              console.error('[auth] Google returned no credential');
              return;
            }
            idToken = response.credential;
            onSignedIn();
          },
          auto_select: true,
          cancel_on_tap_outside: false,
          use_fedcm_for_prompt: true,
        });
        id.prompt();
        resolve(true);
      } else if (Date.now() - startedAt > GIS_TIMEOUT_MS) {
        clearInterval(timer);
        console.error('[auth] Google sign-in script did not load');
        resolve(false);
      }
    }, GIS_POLL_MS);
  });
}

export function renderSignInButton(el: HTMLElement): void {
  googleId?.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
}

export function promptSignIn(): void {
  try {
    googleId?.prompt();
  } catch (err) {
    console.error('[auth] prompt failed', err);
  }
}

export function signOut(): void {
  clearIdToken();
  googleId?.disableAutoSelect();
}
