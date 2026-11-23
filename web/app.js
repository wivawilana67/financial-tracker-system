// Entry point: boot flow (setup, Google sign-in, session), the two tabs, settings, install button and Back handling.

import { getSettings, saveSettings, fetchClientId, call, onUnauthorized, envMismatch } from './api.js';
import { initAuth, promptSignIn, signOut, clearIdToken } from './auth.js';
import { $, showView, text, runAction } from './ui.js';
import { ENV, IS_TEST, STORAGE_PREFIX } from './config.js';
import * as cc from './cc.js';
import * as home from './home.js';

const TAB_KEY = `${STORAGE_PREFIX}tab`;
const TABS = ['cc', 'fin'];

let session = null; // {email, persons, month}, kept in memory only
let signedIn = false;
let currentTab = 'cc';
let clientId = '';
let deferredInstall = null;

function readTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.includes(saved) ? saved : 'cc';
  } catch (err) {
    console.error('[app] tab memory unavailable', err);
    return 'cc';
  }
}

function writeTab(name) {
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch (err) {
    console.error('[app] tab not remembered', err);
  }
}

function setSignedInChrome(on) {
  signedIn = on;
  $('tabbar').hidden = !on;
  $('settings-btn').hidden = !on;
}

function showSetup() {
  setSignedInChrome(false);
  showView('setup');
}

function showSignIn(message = '') {
  setSignedInChrome(false);
  showView('signin');
  $('signin-status').textContent = message;
}

function resetSections() {
  cc.reset();
  home.reset();
  session = null;
  $('account-email').textContent = '';
}

async function startSignIn() {
  showSignIn('Loading sign-in…');
  try {
    if (!clientId) clientId = await fetchClientId();
    initAuth(clientId, onSignedIn);
  } catch (err) {
    console.error('[app] sign-in setup failed', err);
    $('signin-status').textContent = err.message;
  }
}

// Google calls this after one-tap or the button. Loads the session, then opens the last tab.
async function onSignedIn() {
  const info = await runAction(null, () => call('session'));
  if (!info) return;
  const mismatch = envMismatch(info.env);
  if (mismatch) {
    // Do not load any section from the wrong backend; the user fixes the URL in Settings.
    clearIdToken();
    showSignIn(mismatch);
    return;
  }
  session = info;
  $('account-email').textContent = text(info.email);
  setSignedInChrome(true);
  await showTab(readTab());
}

async function showTab(name) {
  currentTab = name;
  writeTab(name);
  history.replaceState({ view: name }, '');
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.tab === name ? 'page' : 'false');
  });
  showView(name);
  if (name === 'cc') await cc.enter();
  else await home.enter(session);
}

function openSettings() {
  const { url, token } = getSettings();
  $('settings-url').value = url;
  $('settings-token').value = token;
  $('settings-status').textContent = '';
  showView('settings');
  history.pushState({ view: 'settings' }, '');
}

function onPopState(event) {
  if (!signedIn) {
    // Settings can be opened from the sign-in view, so Back returns there.
    if (!$('view-settings').hidden) showView('signin');
    return;
  }
  showView(event.state?.view === 'settings' ? 'settings' : currentTab);
}

// Test copy: orange banner, title prefix and the environment label in Settings.
function applyEnvironment() {
  $('env-label').textContent = ENV.toUpperCase();
  if (!IS_TEST) return;
  document.title = `TEST · ${document.title}`;
  document.body.classList.add('is-test');
  $('env-banner').hidden = false;
}

function onSessionExpired() {
  resetSections();
  history.replaceState({ view: 'signin' }, '');
  showSignIn('Your session ended. Sign in again.');
  promptSignIn();
}

function onSignOut() {
  signOut();
  resetSections();
  history.replaceState({ view: 'signin' }, '');
  showSignIn('Signed out. Sign in to continue.');
}

function onSetupSubmit(event) {
  event.preventDefault();
  try {
    saveSettings($('setup-url').value.trim(), $('setup-token').value.trim());
  } catch (err) {
    $('setup-status').textContent = err.message;
    return;
  }
  $('setup-status').textContent = '';
  startSignIn();
}

function onSettingsSubmit(event) {
  event.preventDefault();
  try {
    saveSettings($('settings-url').value.trim(), $('settings-token').value.trim());
  } catch (err) {
    $('settings-status').textContent = err.message;
    return;
  }
  // A different backend can have a different client ID, so reload and sign in again against it.
  location.reload();
}

// Android (Chrome): the Install button appears when the browser offers it. iPhone: a hint in Settings.
function initInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event;
    $('install-btn').hidden = false;
  });
  window.addEventListener('appinstalled', () => { $('install-btn').hidden = true; });
  $('install-btn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try {
      await deferredInstall.userChoice;
    } catch (err) {
      console.error('[app] install prompt failed', err);
    }
    deferredInstall = null;
    $('install-btn').hidden = true;
  });
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('ios-hint').hidden = !ios || installed;
}

function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.error('[app] service worker not registered', err));
  }
  onUnauthorized(onSessionExpired);
  cc.init();
  home.init();
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  });
  document.querySelectorAll('[data-back]').forEach((button) => {
    button.addEventListener('click', () => history.back());
  });
  $('settings-btn').addEventListener('click', openSettings);
  $('signin-settings-btn').addEventListener('click', openSettings);
  applyEnvironment();
  $('setup-form').addEventListener('submit', onSetupSubmit);
  $('settings-form').addEventListener('submit', onSettingsSubmit);
  $('sign-out').addEventListener('click', onSignOut);
  window.addEventListener('popstate', onPopState);
  initInstall();

  const { url, token } = getSettings();
  if (!url || !token) {
    $('setup-url').value = url;
    $('setup-token').value = token;
    showSetup();
    return;
  }
  startSignIn();
}

init();
