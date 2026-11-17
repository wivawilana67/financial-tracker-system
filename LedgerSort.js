/**
 * LedgerSort.js — keeps the ledger sheets in a predictable order.
 *
 * `sortLedgerSheets()` is called from the onOpen simple trigger in Menu.js and
 * is also exposed on the Automation menu. It is deliberately self-contained and
 * side-effect-safe, so it can be attached to an installable "On open" trigger
 * as-is if the simple trigger ever lacks permission to write.
 *
 * Sorting only reorders rows; it never adds, removes or edits a value.
 */

/**
 * Sheets to sort, and the 1-based columns to order them by (all ascending).
 *
 * Ledger layout : A Date | B List | C Type | D Amount | E Note/Channel | ...
 * Income layout : A Date | B Person | C Category | D Amount
 *
 * Date leads everywhere so the newest month stays at the bottom, which is both
 * how the sheets already grow and what keeps the monthly merge writing the
 * smallest possible block. The secondary keys mirror the order the rollover
 * checklists use, so a sheet reads the same way as the dialog that fills it.
 *
 * Literal column numbers on purpose: this runs at file-load time, and Apps
 * Script does not guarantee that Common.js has been evaluated first.
 */
var LEDGER_SORT_KEYS = {
  'Income': [1, 2, 3],        // Date, Person, Category
  'Saving': [1, 3, 5, 2],     // Date, Type, Note/Channel, List
  'Expense': [1, 3, 5, 2],    // Date, Type, Note/Channel, List
  'Ibadah': [1, 3, 5, 2]      // Date, Type, Note/Channel, List
};

/** Order the sheets are processed in. */
var SORTABLE_LEDGERS = ['Income', 'Saving', 'Expense', 'Ibadah'];

/**
 * Ledger-shaped sheets this file deliberately leaves alone still get ordered in
 * the Monthly Data form, so they reuse the shared ledger key order.
 */
var LEDGER_SORT_KEYS_FALLBACK = [1, 3, 5, 2]; // Date, Type, Note/Channel, List

/**
 * Maps a 1-based ledger column to the field name the Monthly Data form uses for
 * it, so one definition (LEDGER_SORT_KEYS) drives both the sheet sort and the
 * dialog. Columns the form has no counterpart for are intentionally absent:
 * Date carries no signal there, since every listed row is in the same month.
 */
var LEDGER_SORT_COLUMN_FIELDS = {
  2: 'list',
  3: 'type',
  5: 'channel'
};

/**
 * Translates a sheet's sort columns into the field names the Monthly Data form
 * can sort on, in the same priority order.
 *
 * @param {string} sheetName Ledger sheet name.
 * @return {Array<string>} Field names, highest priority first.
 */
function getLedgerSortFields(sheetName) {
  var columns = LEDGER_SORT_KEYS[sheetName] || LEDGER_SORT_KEYS_FALLBACK;
  var fields = [];

  for (var i = 0; i < columns.length; i++) {
    var field = LEDGER_SORT_COLUMN_FIELDS[columns[i]];
    if (field) fields.push(field);
  }
  return fields;
}

/**
 * Sorts every configured ledger sheet.
 *
 * Safe to call from a simple onOpen trigger, an installable trigger, the menu,
 * or the Apps Script editor. Failures are logged and reported rather than
 * thrown, so a permission problem can never stop the spreadsheet from opening.
 *
 * @return {{success: boolean, sorted: Array<string>, skipped: Array<string>,
 *           error: (string|undefined)}} What happened.
 */
function sortLedgerSheets() {
  var context = 'sortLedgerSheets';
  var sorted = [];
  var skipped = [];

  try {
    var ss = getBook_();

    for (var i = 0; i < SORTABLE_LEDGERS.length; i++) {
      var name = SORTABLE_LEDGERS[i];
      var sheet = ss.getSheetByName(name);

      if (!sheet) {
        skipped.push(name + ' (missing)');
        continue;
      }
      if (sortLedgerSheet_(sheet, LEDGER_SORT_KEYS[name])) {
        sorted.push(name);
      } else {
        skipped.push(name + ' (nothing to sort)');
      }
    }

    logInfo(context, 'Sorted: ' + (sorted.join(', ') || 'none') +
        ' | Skipped: ' + (skipped.join(', ') || 'none'));
    return { success: true, sorted: sorted, skipped: skipped };
  } catch (e) {
    logError(context, e);
    return { success: false, sorted: sorted, skipped: skipped, error: e.toString() };
  }
}

/**
 * Sorts one sheet's data rows, leaving the header row in place.
 *
 * The sorted range spans every used column so entire rows travel together, and
 * stops at the last dated row so anything parked below the ledger is untouched.
 *
 * @param {Sheet} sheet Sheet to sort.
 * @param {Array<number>} sortColumns 1-based columns, in priority order.
 * @return {boolean} True when a sort was actually performed.
 */
function sortLedgerSheet_(sheet, sortColumns) {
  if (!sortColumns || !sortColumns.length) return false;

  var lastRow = getLastRowByColumnA(sheet);
  if (lastRow <= 2) return false; // header plus at most one row: already ordered

  var widestSortColumn = 0;
  var order = [];
  for (var i = 0; i < sortColumns.length; i++) {
    order.push({ column: sortColumns[i], ascending: true });
    if (sortColumns[i] > widestSortColumn) widestSortColumn = sortColumns[i];
  }

  var totalColumns = Math.max(sheet.getLastColumn(), widestSortColumn);
  sheet.getRange(2, 1, lastRow - 1, totalColumns).sort(order);
  return true;
}

/**
 * Menu entry point: sorts the ledgers and reports the result as a toast.
 */
function runSortLedgerSheets() {
  var context = 'runSortLedgerSheets';
  var result = sortLedgerSheets();

  try {
    var ss = getBook_();
    if (result.success) {
      ss.toast(result.sorted.length ? 'Sorted: ' + result.sorted.join(', ')
                                    : 'Nothing to sort.', 'Ledger Sort', 5);
    } else {
      ss.toast('Sort failed: ' + result.error, 'Ledger Sort', 8);
    }
  } catch (e) {
    logError(context, e);
  }

  return result;
}
