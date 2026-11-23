/**
 * Auth.js — access control for the phone web app API.
 *
 * Every API call must carry two proofs: a shared secret (API_TOKEN) and a
 * Google ID token whose email is on the ALLOWED_EMAILS list. Failed calls are
 * counted in the script cache, and the API refuses everything for a while once
 * the count passes AUTH_FAIL_LIMIT. Secrets and tokens are never logged.
 */

var API_PROPS = { token: 'API_TOKEN', clientId: 'GOOGLE_CLIENT_ID', emails: 'ALLOWED_EMAILS', env: 'APP_ENV' };
var AUTH_FAIL_LIMIT = 20;          // failed calls ...
var AUTH_FAIL_WINDOW_SECONDS = 600; // ... within this window lock the API for the same window
var AUTH_FAIL_KEY = 'auth:fails';

/** Google's endpoint that verifies an ID token and returns its claims. */
var GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
/** Longest a verified ID token is remembered, in seconds. */
var ID_TOKEN_CACHE_MAX_SECONDS = 21600;

/**
 * @param {string} key Script Property name (see API_PROPS).
 * @return {string} The stored value, or '' when it is not set.
 */
function getApiProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

/**
 * @param {string} text Text to hash.
 * @return {string} Lowercase hex SHA-256 digest.
 */
function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var hex = (b & 0xff).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * Refuses the call outright while the failure count for this window is too high.
 * @throws {Error} 'Unauthorized' when throttled.
 */
function assertNotThrottled_() {
  var value = CacheService.getScriptCache().get(AUTH_FAIL_KEY);
  if (Number(value) >= AUTH_FAIL_LIMIT) throw new Error('Unauthorized');
}

/**
 * Adds one to the failed-call count for the current window.
 */
function recordAuthFailure_() {
  var cache = CacheService.getScriptCache();
  var count = (Number(cache.get(AUTH_FAIL_KEY)) || 0) + 1;
  cache.put(AUTH_FAIL_KEY, String(count), AUTH_FAIL_WINDOW_SECONDS);
}

/**
 * Checks the shared secret. Both sides are hashed first so the comparison runs
 * over equal-length values.
 * @param {*} token Token sent by the phone.
 * @throws {Error} 'Unauthorized' on any mismatch or when the secret is not configured.
 */
function assertToken_(token) {
  var expected = getApiProp_(API_PROPS.token);
  if (expected.length < 32) {
    logInfo('assertToken_', API_PROPS.token + ' is missing or shorter than 32 characters.');
    throw new Error('Unauthorized');
  }
  if (typeof token !== 'string') throw new Error('Unauthorized');
  if (sha256Hex_(token) !== sha256Hex_(expected)) throw new Error('Unauthorized');
}

/**
 * @return {Array<string>} ALLOWED_EMAILS, trimmed and lowercased, empties dropped.
 */
function getAllowedEmails_() {
  return getApiProp_(API_PROPS.emails).split(',')
      .map(function (e) { return e.trim().toLowerCase(); })
      .filter(function (e) { return e !== ''; });
}

/** @return {string} 'test' or 'prod' from Script Property APP_ENV, or '' when unset/invalid. */
function getAppEnv_() {
  var env = getApiProp_(API_PROPS.env).trim().toLowerCase();
  return env === 'test' || env === 'prod' ? env : '';
}

/**
 * Verifies a Google ID token with Google and checks it belongs to this app and an
 * allowed user. Verified tokens are cached until shortly before they expire.
 * @param {*} idToken ID token sent by the phone.
 * @return {string} The lowercased email of the verified user.
 * @throws {Error} 'Unauthorized' on any failure; the reason is never returned.
 */
function verifyGoogleUser_(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 4096) {
    throw new Error('Unauthorized');
  }

  var cacheKey = 'idt:' + sha256Hex_(idToken);
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  var res = UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL + '?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Unauthorized');

  var info;
  try {
    info = JSON.parse(res.getContentText());
  } catch (parseError) {
    throw new Error('Unauthorized');
  }
  if (!info || typeof info !== 'object') throw new Error('Unauthorized');

  var clientId = getApiProp_(API_PROPS.clientId);
  var email = String(info.email || '').trim().toLowerCase();
  var issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  var notExpired = Number(info.exp) * 1000 > Date.now();

  if (!clientId || info.aud !== clientId || !issuerOk ||
      String(info.email_verified) !== 'true' || !notExpired ||
      !email || getAllowedEmails_().indexOf(email) === -1) {
    throw new Error('Unauthorized');
  }

  var ttl = Math.min(ID_TOKEN_CACHE_MAX_SECONDS, Math.floor(Number(info.exp) - Date.now() / 1000) - 30);
  if (ttl > 0) cache.put(cacheKey, email, ttl);
  return email;
}

/**
 * Run once from the Apps Script editor by the owner, to grant the scopes the web
 * app needs (external requests, cache, spreadsheet). Logs which settings exist,
 * never their values.
 */
function authorizeApi() {
  var context = 'authorizeApi';
  UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL, { muteHttpExceptions: true });
  CacheService.getScriptCache();
  logInfo(context, 'Spreadsheet: ' + getBook_().getName());

  var keys = [API_PROPS.token, API_PROPS.clientId, API_PROPS.emails, 'SPREADSHEET_ID', 'APP_ENV'];
  keys.forEach(function (key) {
    logInfo(context, key + ': ' + (getApiProp_(key) ? 'set' : 'MISSING'));
  });
}
