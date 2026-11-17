// Google Identity Services: the sign-in button, the one-tap prompt and the ID token (memory only).

import { $ } from './ui.js';

const GIS_POLL_MS = 100;
const GIS_TIMEOUT_MS = 10000;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

let idToken = null;
let initialized = false;

// Returns the token only while it has at least two minutes left; otherwise the user must sign in again.
export function getIdToken() {
  if (!idToken) return null;
  if (tokenExpiryMs(idToken) - Date.now() < REFRESH_MARGIN_MS) {
    clearIdToken();
    return null;
  }
  return idToken;
}

export function clearIdToken() {
  idToken = null;
}

// Reads the exp claim only. A token without a readable expiry counts as expired.
function tokenExpiryMs(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { exp } = JSON.parse(new TextDecoder().decode(bytes));
    return Number(exp) * 1000 || 0;
  } catch (err) {
    console.error('[auth] token expiry unreadable', err);
    return 0;
  }
}

// Waits for the Google script (async in index.html), then sets up the button and one-tap prompt.
export function initAuth(clientId, onSignedIn) {
  if (initialized) return;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (window.google?.accounts?.id) {
      clearInterval(timer);
      setupGoogle(clientId, onSignedIn);
    } else if (Date.now() - startedAt > GIS_TIMEOUT_MS) {
      clearInterval(timer);
      $('signin-status').textContent = 'Google sign-in could not load';
    }
  }, GIS_POLL_MS);
}

function setupGoogle(clientId, onSignedIn) {
  if (initialized) return;
  initialized = true;
  const id = window.google.accounts.id;
  id.initialize({
    client_id: clientId,
    callback: (response) => {
      if (!response?.credential) {
        $('signin-status').textContent = 'Google did not return a sign-in. Try again.';
        return;
      }
      idToken = response.credential;
      onSignedIn();
    },
    auto_select: true,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true,
  });
  id.renderButton($('gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
  $('signin-status').textContent = '';
  id.prompt();
}

// Shows the one-tap prompt again, for example after the session expired.
export function promptSignIn() {
  if (!initialized) return;
  try {
    window.google.accounts.id.prompt();
  } catch (err) {
    console.error('[auth] prompt failed', err);
  }
}

export function signOut() {
  clearIdToken();
  if (initialized) window.google.accounts.id.disableAutoSelect();
}
