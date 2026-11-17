/**
 * Common.js — shared constants and helpers for the Financial Tracker System.
 *
 * Everything in this file is UI-free and feature-agnostic so that any module
 * (monthly generation, add/update dialogs, automation checklist) can rely on
 * it. Feature logic belongs in the feature's own file.
 */

/** 0-based column positions used by every transaction ledger sheet. */
var LEDGER_COLUMNS = {
  DATE: 0,        // A — first day of the month the row belongs to
  LIST: 1,        // B — item name
  TYPE: 2,        // C — owner / category
  AMOUNT: 3,      // D — IDR amount
  CHANNEL: 4,     // E — payment channel or note
  IS_CICILAN: 5,  // F — installment flag
  REMAINING: 6,   // G — payments remaining
  PAID: 7         // H — "Sudah Bayar?" checkbox
};

/** Ledger sheets always expose at least the eight columns above. */
var LEDGER_MIN_COLUMNS = 8;

/** Rendered in place of an empty ledger cell (also used when matching rows). */
var BLANK_PLACEHOLDER = '—';

/** Separator for composite lookup keys; cannot occur in spreadsheet text. */
var KEY_SEPARATOR = '\u0000';
/** First row of the Master sheet that holds option values (rows 1-2 are titles). */
var MASTER_FIRST_DATA_ROW = 3;

/** Standard size of every modal dialog in this project. */
var DIALOG_WIDTH = 750;
var DIALOG_HEIGHT = 750;

/* ==========================================================================
 * Logging
 * ========================================================================== */

/**
 * Writes a namespaced info line to the Apps Script log.
 * @param {string} context Name of the calling function.
 * @param {string} message Short, non-sensitive description of what happened.
 */
function logInfo(context, message) {
  Logger.log('[' + context + '] ' + message);
}

/**
 * Writes a namespaced error line, including the stack trace when available.
 * @param {string} context Name of the calling function.
 * @param {*} error The caught error.
 */
function logError(context, error) {
  var detail = (error && error.stack) ? error.stack : String(error);
  Logger.log('[' + context + '] ERROR: ' + detail);
}

/* ==========================================================================
 * Spreadsheet, locks, safe text
 * ========================================================================== */

/** Default wait for the document lock before a write gives up. */
var DOCUMENT_LOCK_TIMEOUT_MS = 30000;

/**
 * The spreadsheet every feature reads and writes. Menus and triggers run bound
 * to the sheet, so the active spreadsheet is used there. The phone web app has
 * no bound sheet, so it falls back to the SPREADSHEET_ID Script Property.
 * @return {Spreadsheet} The target spreadsheet.
 */
function getBook_() {
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('No active spreadsheet and Script Property SPREADSHEET_ID is not set.');
  return SpreadsheetApp.openById(id);
}

/**
 * The lock that serialises writes to the spreadsheet. The document lock when
 * one exists, otherwise the script lock (the web app runs unbound).
 * @return {Lock} A lock object, not yet acquired.
 */
function getLock_() {
  var lock = null;
  try { lock = LockService.getDocumentLock(); } catch (e) { lock = null; }
  return lock || LockService.getScriptLock();
}

/**
 * Runs a write under the spreadsheet lock, so two writers can never interleave.
 * @param {string} context Calling function name, for the log.
 * @param {function(Spreadsheet): *} fn Work to run; receives the target spreadsheet.
 * @param {number=} timeoutMs How long to wait for the lock (default 30000).
 * @return {*} Whatever fn returns.
 * @throws {Error} When the lock cannot be obtained in time.
 */
function withDocumentLock_(context, fn, timeoutMs) {
  var lock = getLock_();
  var wait = timeoutMs || DOCUMENT_LOCK_TIMEOUT_MS;
  if (!lock.tryLock(wait)) {
    logInfo(context, 'Could not obtain the spreadsheet lock within ' + wait + ' ms.');
    throw new Error('The spreadsheet is busy with another change. Try again in a moment.');
  }
  try {
    return fn(getBook_());
  } finally {
    lock.releaseLock();
  }
}

/**
 * Makes text safe to write into a cell. A leading = + - or @ would be read as a
 * formula, so it is prefixed with an apostrophe, which Sheets stores as text.
 * @param {*} value Any value headed for a cell.
 * @return {string} The text to write ('' for null/undefined).
 */
function safeCellText_(value) {
  if (value === null || value === undefined) return '';
  var text = String(value);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

/* ==========================================================================
 * Formatting
 * ========================================================================== */

/**
 * Truncates any supported date representation to the first day of its month.
 * @param {Date|string|*} val Cell value.
 * @return {string} 'yyyy-MM-01', or '' when the value is not a date.
 */
function formatDateToYMD(val) {
  if (val instanceof Date) {
    return monthStartString_(val.getFullYear(), val.getMonth());
  }
  if (typeof val === 'string' && val.trim() !== '') {
    var match = val.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (match) return match[1] + '-' + match[2] + '-01';
    var parsed = new Date(val);
    if (!isNaN(parsed.getTime())) {
      return monthStartString_(parsed.getFullYear(), parsed.getMonth());
    }
  }
  return '';
}

/**
 * Builds the canonical 'yyyy-MM-01' key used as the ledger date value.
 * @param {number} year Full year.
 * @param {number} monthIndex 0-based month (may be -1 or 12 to roll over).
 * @return {string} Month key.
 */
function monthStartString_(year, monthIndex) {
  var normalized = new Date(year, monthIndex, 1);
  return normalized.getFullYear() + '-' +
      String(normalized.getMonth() + 1).padStart(2, '0') + '-01';
}

/**
 * Formats a number as Indonesian Rupiah with '.' thousand separators.
 * Non-numeric input degrades to "IDR 0" instead of throwing.
 * @param {*} num Value to format.
 * @return {string} e.g. "IDR 1.500.000".
 */
function formatCurrency(num) {
  var value = Number(num);
  if (!isFinite(value)) return 'IDR 0';

  var isNegative = value < 0;
  var absolute = Math.abs(value);
  var whole = Math.floor(absolute);
  var text = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  var cents = Math.round((absolute - whole) * 100);
  if (cents > 0) text += ',' + String(cents).padStart(2, '0');

  return 'IDR ' + (isNegative ? '-' : '') + text;
}

/**
 * Serialises a value into a JavaScript string literal that is safe to inline
 * inside a <script> block of an HtmlService template. Guards against values
 * that would otherwise terminate the script tag or the string literal.
 * @param {*} value Any JSON-serialisable value.
 * @return {string} A quoted, fully escaped literal (quotes included).
 */
function toScriptLiteral_(value) {
  return JSON.stringify(JSON.stringify(value))
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
}

/**
 * The month the spreadsheet is currently in, as 'yyyy-MM'.
 *
 * Every dialog opens on this month. It is read from the spreadsheet's own
 * timezone rather than the browser clock, so the form and the ledger dates it
 * writes can never disagree about which month "now" is — which is exactly what
 * a machine set to another timezone would cause around a month boundary.
 * @return {string} Current month key ('yyyy-MM').
 */
function currentMonthKey() {
  var timeZone;
  try {
    timeZone = getBook_().getSpreadsheetTimeZone();
  } catch (e) {
    timeZone = Session.getScriptTimeZone();
  }
  return Utilities.formatDate(new Date(), timeZone, 'yyyy-MM');
}

/* ==========================================================================
 * Lookups
 * ========================================================================== */

/**
 * Turns a list into a prototype-less lookup object for O(1) membership tests.
 * @param {Array<*>} list Values to index.
 * @return {!Object} Map of value -> true.
 */
function toLookupSet_(list) {
  var set = Object.create(null);
  if (!list || !list.length) return set;
  for (var i = 0; i < list.length; i++) {
    if (list[i] !== null && list[i] !== undefined) set[String(list[i])] = true;
  }
  return set;
}

/**
 * Same as toLookupSet_ but trims and lowercases each entry.
 * @param {Array<*>} list Values to index.
 * @return {!Object} Map of normalized value -> true.
 */
function toLowerLookupSet_(list) {
  var set = Object.create(null);
  if (!list || !list.length) return set;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === null || list[i] === undefined) continue;
    set[String(list[i]).trim().toLowerCase()] = true;
  }
  return set;
}

/**
 * Builds a map key that behaves like strict equality for primitive cell values
 * (so the number 1 and the string "1" never collide).
 * @param {*} value Cell value.
 * @return {string} Type-tagged key.
 */
function strictKey_(value) {
  return typeof value + KEY_SEPARATOR + String(value);
}

/**
 * Reads a ledger cell, substituting the blank placeholder for empty values.
 * @param {*} value Cell value.
 * @return {*} The value, or BLANK_PLACEHOLDER when falsy.
 */
function orPlaceholder_(value) {
  return value || BLANK_PLACEHOLDER;
}

/**
 * The two people the jajan budget is split between, in report order.
 * The Autodeduct Jajan sheet holds the owner in its Type column; the Expense
 * ledger's Jajan rows hold it in List.
 */
var JAJAN_OWNERS = ['Wiva', 'Jane'];

/**
 * Resolves an owner cell to one of JAJAN_OWNERS. Wiva is also recorded as
 * "Rio" in older rows, so both spellings map to the same person.
 * @param {*} value Owner cell (Type on Autodeduct Jajan, List on Expense).
 * @return {string} 'Wiva', 'Jane', or '' when the cell names neither.
 */
function normaliseJajanOwner_(value) {
  var who = (value === null || value === undefined) ? '' : String(value).trim().toLowerCase();
  if (who === 'wiva' || who === 'rio') return 'Wiva';
  if (who === 'jane') return 'Jane';
  return '';
}

/**
 * @param {*} type Value of the Type column.
 * @return {boolean} True when the row belongs to the Jajan category.
 */
function isJajanRow_(type) {
  return !!type && type.toString().trim().toLowerCase() === 'jajan';
}

/**
 * Interprets a checkbox cell as a boolean.
 * @param {*} value Cell value.
 * @return {boolean} True when the checkbox is ticked.
 */
function isCheckedCell_(value) {
  return value === true || value === 'TRUE';
}

/* ==========================================================================
 * Sheet access
 * ========================================================================== */

/**
 * Scans Column A to find the last row containing an actual date/data value.
 * @param {Sheet} sheet The sheet object.
 * @return {number} Last row number containing data.
 */
function getLastRowByColumnA(sheet) {
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return lastRow;
  var values = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var val = values[i][0];
    if (val !== '' && val !== null && val !== undefined) return i + 1;
  }
  return 1;
}

/**
 * Reads a ledger sheet in a single Range call and returns a snapshot that both
 * the candidate scanner and the merge writer can reuse. Doing this once per
 * sheet replaces three separate round trips to the Sheets service.
 *
 * @param {Sheet} sheet Ledger sheet to read.
 * @return {{sheet: Sheet, name: string, totalColumns: number,
 *           absoluteLastRow: number, values: Array<Array<*>>}} Snapshot where
 *     `values` covers the header plus every row that carries a date in column A.
 */
function readLedgerSnapshot_(sheet) {
  var absoluteLastRow = sheet.getLastRow();
  var totalColumns = Math.max(sheet.getLastColumn() || LEDGER_MIN_COLUMNS, LEDGER_MIN_COLUMNS);
  var raw = absoluteLastRow > 0
      ? sheet.getRange(1, 1, absoluteLastRow, totalColumns).getValues()
      : [];

  // Rows below the last dated row are trailing leftovers, not ledger data.
  var dataRowCount = absoluteLastRow <= 1 ? absoluteLastRow : 1;
  for (var i = raw.length - 1; i >= 1; i--) {
    var dateCell = raw[i][LEDGER_COLUMNS.DATE];
    if (dateCell !== '' && dateCell !== null && dateCell !== undefined) {
      dataRowCount = i + 1;
      break;
    }
  }

  return {
    sheet: sheet,
    name: sheet.getName(),
    totalColumns: totalColumns,
    absoluteLastRow: absoluteLastRow,
    values: raw.slice(0, dataRowCount)
  };
}

/**
 * First row a new ledger entry can be written to: straight after the last dated
 * row, so additions never land below a gap.
 *
 * sheet.getLastRow() is not usable for this: the template's Cicilan? / Sudah
 * Bayar? checkboxes can hold FALSE down to row 1000, so it points past them.
 * The two checkbox columns are ignored here altogether, ticked or not — a row
 * whose only value is a checkbox is free. A trailing row with anything in its
 * other columns (a date, list, type, amount, channel, remaining count, or a
 * note further right) is still respected: an undated row is never overwritten.
 *
 * @param {Object} snapshot Snapshot from readLedgerSnapshot_.
 * @return {number} 1-based row number.
 */
function firstFreeLedgerRow_(snapshot) {
  var lastDated = snapshot.values.length;
  var trailing = snapshot.absoluteLastRow - lastDated;
  if (trailing <= 0) return lastDated + 1;

  var checkboxColumns = [LEDGER_COLUMNS.IS_CICILAN, LEDGER_COLUMNS.PAID];
  var rows = snapshot.sheet.getRange(lastDated + 1, 1, trailing, snapshot.totalColumns).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    var holdsData = rows[i].some(function (cell, c) {
      if (checkboxColumns.indexOf(c) !== -1) return false;
      return cell !== null && cell !== undefined && String(cell).trim() !== '';
    });
    if (holdsData) {
      logInfo('firstFreeLedgerRow_', snapshot.name + ': undated content at row ' +
          (lastDated + 1 + i) + ' is kept; new rows go below it.');
      return lastDated + i + 2;
    }
  }
  return lastDated + 1;
}

/**
 * Pads a row to the sheet's column count so setValues() never rejects it.
 * @param {Array<*>} row Row values.
 * @param {number} totalColumns Target width.
 * @return {Array<*>} The same array, padded in place.
 */
function padRow_(row, totalColumns) {
  while (row.length < totalColumns) row.push('');
  return row;
}

/**
 * Grows the sheet so a write ending at `lastNeededRow` stays inside its bounds.
 *
 * A sheet that has been trimmed to exactly its data has no spare rows at the
 * bottom, and getRange() past the last one throws instead of growing the grid.
 * Every append path has to call this first.
 *
 * @param {Sheet} sheet Sheet about to be written to.
 * @param {number} lastNeededRow Last row number the write will touch.
 * @return {number} How many rows were added (0 when none were needed).
 */
function ensureRowCapacity_(sheet, lastNeededRow) {
  var maxRows = sheet.getMaxRows();
  var missing = lastNeededRow - maxRows;
  if (missing <= 0) return 0;
  sheet.insertRowsAfter(maxRows, missing);
  return missing;
}

/**
 * Deletes rows from the bottom up so earlier row numbers stay valid, collapsing
 * consecutive runs into a single deleteRows() call. Duplicates are ignored and
 * the input may arrive in any order.
 *
 * This lives in Common.js on purpose: two features delete ledger rows, and a
 * second copy in a feature file would silently shadow this one at load time.
 *
 * @param {Sheet} sheet Target sheet.
 * @param {Array<number>} rowNumbers 1-based row numbers, any order.
 * @return {number} How many rows were removed.
 */
function deleteRowsDescending_(sheet, rowNumbers) {
  if (!sheet || !rowNumbers || !rowNumbers.length) return 0;

  var unique = [];
  var seen = Object.create(null);
  for (var i = 0; i < rowNumbers.length; i++) {
    var rowNum = parseInt(rowNumbers[i], 10);
    if (isNaN(rowNum) || rowNum < 1 || seen[rowNum]) continue;
    seen[rowNum] = true;
    unique.push(rowNum);
  }
  unique.sort(function (a, b) { return b - a; });

  var deleted = 0;
  var cursor = 0;
  while (cursor < unique.length) {
    var end = unique[cursor];
    var start = end;
    var next = cursor + 1;
    while (next < unique.length && unique[next] === start - 1) {
      start = unique[next];
      next++;
    }
    sheet.deleteRows(start, end - start + 1);
    deleted += end - start + 1;
    cursor = next;
  }
  return deleted;
}

/**
 * Reads every option list held by the Master sheet in one Range call.
 *
 * Column layout: A = income categories, C = saving types, E = expense types,
 * G = ibadah types, I = payment channels.
 *
 * @return {{found: boolean, incomeCategories: Array<string>,
 *           savingTypes: Array<string>, expenseTypes: Array<string>,
 *           ibadahTypes: Array<string>, paymentChannels: Array<string>}} Lists.
 */
function readMasterLists_() {
  var lists = {
    found: false,
    incomeCategories: [],
    savingTypes: [],
    expenseTypes: [],
    ibadahTypes: [],
    paymentChannels: []
  };

  var masterSheet = getBook_().getSheetByName('Master');
  if (!masterSheet) return lists;
  lists.found = true;

  var lastRow = masterSheet.getLastRow();
  if (lastRow < MASTER_FIRST_DATA_ROW) return lists;

  var rowCount = lastRow - MASTER_FIRST_DATA_ROW + 1;
  var values = masterSheet.getRange(MASTER_FIRST_DATA_ROW, 1, rowCount, 9).getValues();

  var columns = [
    { index: 0, target: lists.incomeCategories },
    { index: 2, target: lists.savingTypes },
    { index: 4, target: lists.expenseTypes },
    { index: 6, target: lists.ibadahTypes },
    { index: 8, target: lists.paymentChannels }
  ];

  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < columns.length; c++) {
      var cell = values[r][columns[c].index];
      var text = (cell === null || cell === undefined) ? '' : cell.toString().trim();
      if (text !== '') columns[c].target.push(text);
    }
  }

  return lists;
}
