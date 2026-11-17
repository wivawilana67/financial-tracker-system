// Backend calls and the two localStorage keys (backend URL, token). Nothing else is stored.
// The Google ID token comes from auth.js and is sent in the body only; it is never persisted.

import { getIdToken, clearIdToken } from './auth.js';

const KEYS = { url: 'fintrack.backendUrl', token: 'fintrack.token' };
const BACKEND_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
const CLIENT_ID_PATTERN = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const MIN_TOKEN_LENGTH = 32;

let onSessionExpired = () => {};

// app.js registers what happens when the backend says the sign-in is no longer valid.
export function onUnauthorized(handler) {
  onSessionExpired = handler;
}

function read(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (err) {
    console.error('[api] localStorage read blocked', err);
    return '';
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error('[api] localStorage write blocked', err);
    return false;
  }
}

// Values that fail validation are treated as missing, so a corrupted entry sends the user to setup.
export function getSettings() {
  const url = read(KEYS.url);
  const token = read(KEYS.token);
  return {
    url: BACKEND_PATTERN.test(url) ? url : '',
    token: token.length >= MIN_TOKEN_LENGTH ? token : '',
  };
}

export function saveSettings(url, token) {
  if (!BACKEND_PATTERN.test(url)) throw new Error('The backend URL must look like https://script.google.com/macros/s/…/exec');
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`The token must be at least ${MIN_TOKEN_LENGTH} characters`);
  if (!write(KEYS.url, url) || !write(KEYS.token, token)) throw new Error('This browser blocked saving settings');
}

// GET <backendUrl> returns the public Google OAuth client ID.
export async function fetchClientId() {
  const { url } = getSettings();
  if (!url) throw new Error('Set the backend URL first');
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  const json = await res.json();
  if (!json.ok || !CLIENT_ID_PATTERN.test(json.clientId)) {
    throw new Error(json.error || 'Sign-in is not configured on the backend');
  }
  return json.clientId;
}

function expireSession() {
  clearIdToken();
  onSessionExpired();
}

// POST <backendUrl>, text/plain keeps the request "simple" (no CORS preflight).
export async function call(action, data = {}) {
  const { url, token } = getSettings();
  if (!url || !token) throw new Error('Set the backend URL and token first');
  const idToken = getIdToken();
  if (!idToken) {
    expireSession();
    throw new Error('Please sign in again');
  }
  console.debug('[api] call', action);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...data, action, token, idToken }),
    });
  } catch (err) {
    console.error('[api] network failure', action, err);
    throw new Error('No connection to the backend');
  }
  if (!res.ok) throw new Error(`Backend error ${res.status}`);

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error('[api] unreadable response', action, err);
    throw new Error('The backend sent an unexpected response');
  }
  if (!json.ok) {
    if (json.error === 'Unauthorized') {
      expireSession();
      throw new Error('Your session ended. Sign in again.');
    }
    throw new Error(json.error || 'Request failed');
  }
  return json;
}
