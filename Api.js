/**
 * Api.js — JSON API for the phone web app.
 *
 * The phone sends POST with Content-Type text/plain and a JSON body
 * {action, token, idToken, ...params}. text/plain keeps the browser from making
 * a CORS preflight, which Apps Script cannot answer.
 *
 * Every POST is checked in Auth.js (shared secret, then Google ID token) before
 * any action runs. Responses are always JSON: {ok: true, ...} or {ok: false, error}.
 */

var API_MAX_BODY_CHARS = 200000;
var API_MAX_ITEMS = 500;

/** Longest maximum span, in days, one CC sync request may cover. */
var API_CC_SYNC_MAX_DAYS = 62;

/**
 * Public probe. Reveals only the OAuth client id, which the phone needs to sign in.
 * @return {TextOutput} JSON.
 */
function doGet() {
  return apiJson_({ ok: true, clientId: getApiProp_(API_PROPS.clientId) });
}

/**
 * Entry point for every phone request.
 * @param {Object} e Apps Script event; the body is in e.postData.contents.
 * @return {TextOutput} JSON response.
 */
function doPost(e) {
  var context = 'doPost';
  var raw = (e && e.postData && e.postData.contents) || '';
  if (raw.length > API_MAX_BODY_CHARS) return apiJson_({ ok: false, error: 'Request too large' });

  var body;
  try {
    body = JSON.parse(raw);
  } catch (parseError) {
    return apiJson_({ ok: false, error: 'Bad JSON' });
  }
  if (!body || typeof body !== 'object') return apiJson_({ ok: false, error: 'Bad JSON' });

  try {
    assertNotThrottled_();
    var email;
    try {
      assertToken_(body.token);
      email = verifyGoogleUser_(body.idToken);
    } catch (authErr) {
      recordAuthFailure_();
      throw authErr;
    }

    if (!Object.prototype.hasOwnProperty.call(API_ACTIONS, body.action)) {
      throw new Error('Unknown action');
    }
    logInfo(context, 'action=' + body.action + ' user=' + email);
    var result = API_ACTIONS[body.action](body, email);
    return apiJson_(Object.assign({ ok: true }, result));
  } catch (err) {
    logError(context + ' action=' + String(body.action), err);
    var message = err && err.message;
    return apiJson_({
      ok: false,
      error: message === 'Unauthorized' ? 'Unauthorized' : (message || 'Request failed')
    });
  }
}

/**
 * @param {Object} obj Response body.
 * @return {TextOutput} The body as JSON.
 */
function apiJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

/**
 * @param {*} value Month value from the request.
 * @return {string} The value, once shown to be yyyy-MM.
 * @throws {Error} When the value is not yyyy-MM.
 */
function requireMonth_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    throw new Error('Month must look like yyyy-MM.');
  }
  return value;
}

/**
 * @param {*} value Date value from the request.
 * @return {string} The value, once shown to be yyyy-MM-dd.
 * @throws {Error} When the value is not yyyy-MM-dd.
 */
function requireDay_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Date must look like yyyy-MM-dd.');
  }
  return value;
}

/**
 * @param {*} value List from the request.
 * @return {Array<*>} The list, once shown to hold 1 to API_MAX_ITEMS entries.
 * @throws {Error} When the list is missing, empty or too long.
 */
function requireItems_(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > API_MAX_ITEMS) {
    throw new Error('Expected between 1 and ' + API_MAX_ITEMS + ' items.');
  }
  return value;
}

/**
 * Actions the phone may call. Each receives the parsed body and the verified
 * email, and returns a plain object that is merged into the response.
 */
var API_ACTIONS = {
  session: function (body, email) {
    return { email: email, persons: INCOME_PERSONS, month: currentMonthKey() };
  },

  month: function (body) {
    return { payload: getMonthlyEntryPayload(requireMonth_(body.month)) };
  },

  dashboard: function () {
    return { dashboard: readDashboard_() };
  },

  ccList: function () {
    return listCcTracker_();
  },

  ccUpdate: function (body) {
    var changes = requireItems_(body.changes).map(function (c) {
      if (!c || typeof c !== 'object') throw new Error('Each change must be an object.');
      if (!Number.isInteger(c.row) || c.row < CC_TRACKER_FIRST_DATA_ROW) {
        throw new Error('Invalid tracker row.');
      }
      if (typeof c.fingerprint !== 'string' || c.fingerprint === '' || c.fingerprint.length > 2000) {
        throw new Error('Invalid row fingerprint.');
      }
      if (c.paid !== undefined && typeof c.paid !== 'boolean') throw new Error('paid must be true or false.');
      if (c.cancelled !== undefined && typeof c.cancelled !== 'boolean') {
        throw new Error('cancelled must be true or false.');
      }
      if (c.note !== undefined && (typeof c.note !== 'string' || c.note.length > 500)) {
        throw new Error('note must be text of at most 500 characters.');
      }

      var clean = { row: c.row, fingerprint: c.fingerprint };
      if (c.paid !== undefined) clean.paid = c.paid;
      if (c.cancelled !== undefined) clean.cancelled = c.cancelled;
      if (c.note !== undefined) clean.note = c.note;
      return clean;
    });
    return updateCcTrackerRows_(changes);
  },

  ccSync: function (body) {
    var start = requireDay_(body.start);
    var end = requireDay_(body.end);
    var startMs = Date.parse(start);
    var endMs = Date.parse(end);
    if (isNaN(startMs) || isNaN(endMs)) throw new Error('Invalid sync date.');
    if (end < start) throw new Error('End date is before start date.');
    if ((endMs - startMs) / 86400000 > API_CC_SYNC_MAX_DAYS) {
      throw new Error('Sync range is longer than ' + API_CC_SYNC_MAX_DAYS + ' days.');
    }

    var report = withDocumentLock_('ccSync', function () {
      return syncCcTransactions_(start, end, { tracker: true, transaction: true });
    }, 60000);
    return { report: report, message: describeCcSyncReport_(report) };
  },

  ccSettled: function () {
    var ss = getBook_();
    var items = [];
    ROW_CLEANUP_TARGETS.forEach(function (t) {
      var sh = ss.getSheetByName(t.sheetName);
      if (sh) items = items.concat(findCheckedItems_(sh, t));
    });
    return { items: items };
  },

  ccDeleteSettled: function (body) {
    var clean = requireItems_(body.items).map(function (i) {
      if (!i || typeof i !== 'object') throw new Error('Each item must be an object.');
      var rowIndex = parseInt(i.rowIndex, 10);
      if (isNaN(rowIndex)) throw new Error('Invalid row index.');
      return { sheetName: String(i.sheetName), rowIndex: rowIndex, fingerprint: String(i.fingerprint) };
    });
    // deleteConfirmedRows takes the lock itself and re-checks every fingerprint.
    return { result: deleteConfirmedRows(clean) };
  },

  sortLedgers: function () {
    return { result: sortLedgerSheets() };
  }
};
