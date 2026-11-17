/**
 * RowCleanup.js — removes settled rows from the checklist-driven sheets.
 *
 * A row is "settled" when any of its cleanup checkboxes is ticked (on the CC
 * Tracker: I = Paid, J = Cancelled). Such a row is deleted entirely — the row
 * itself, not just its content — so everything below shifts up and no empty gap
 * is left behind. The CC Tracker grid is then topped back up to its template
 * size (restoreCcTrackerRows_ in CcSync.js), so weekly cleans never shrink it.
 *
 * `deleteCheckedRows()` is UI-free and safe to attach to a time-driven
 * installable trigger as-is. The menu path instead opens RowDeletionDialog,
 * which lists every transaction that would go and hands the confirmed rows back
 * to `deleteConfirmedRows()`.
 */

/**
 * Sheets to clean: where the checkboxes live, and where to read the transaction
 * detail shown in the confirmation dialog.
 *
 * `descriptionColumns` / `amountColumns` / `cardColumns` are 1-based columns
 * tried in order, first usable value wins. The sync writes A:G directly; keep
 * these in step with CC_TRACKER_COLS in CcSync.js.
 *
 * Literal numbers on purpose: this is evaluated at file-load time, and Apps
 * Script does not guarantee that Common.js has been read first.
 */
var ROW_CLEANUP_TARGETS = [
  {
    sheetName: 'CC Tracker',
    firstDataRow: 8,        // Row 7 holds the headers
    lastReadColumn: 11,     // A..K — everything the detail lookup can need
    flagColumns: [
      { column: 9, label: 'Paid' },       // I
      { column: 10, label: 'Cancelled' }  // J
    ],
    cardColumns: [3],             // C
    descriptionColumns: [4, 1],   // D, then A
    amountColumns: [6],           // F
    restoreGrid: true             // refill the template rows afterwards (restoreCcTrackerRows_)
  }
];

/** How long a run waits for the document lock before giving up (ms). */
var ROW_CLEANUP_LOCK_TIMEOUT_MS = 30000;

/* ==========================================================================
 * Scanning
 * ========================================================================== */

/**
 * Lists the settled rows of one sheet, with the detail needed to identify them.
 *
 * Reads the whole block in a single Range call, so cost does not grow with the
 * number of ticked boxes.
 *
 * @param {Sheet} sheet Sheet to scan.
 * @param {Object} target Entry from ROW_CLEANUP_TARGETS.
 * @return {Array<{sheetName: string, rowIndex: number, reasons: Array<string>,
 *                 cardNumber: string, description: string, amount: number,
 *                 fingerprint: string}>} Settled rows, top to bottom.
 */
function findCheckedItems_(sheet, target) {
  var firstRow = target.firstDataRow;
  var lastRow = sheet.getLastRow();
  if (lastRow < firstRow) return [];

  var width = Math.min(target.lastReadColumn, Math.max(sheet.getLastColumn(), 1));
  var values = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, width).getValues();

  var items = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];

    var reasons = [];
    for (var f = 0; f < target.flagColumns.length; f++) {
      var flag = target.flagColumns[f];
      if (isCheckedCell_(row[flag.column - 1])) reasons.push(flag.label);
    }
    if (!reasons.length) continue;

    var item = {
      sheetName: target.sheetName,
      rowIndex: firstRow + i,
      reasons: reasons,
      cardNumber: firstText_(row, target.cardColumns) || 'N/A',
      description: firstText_(row, target.descriptionColumns) || '-',
      amount: firstAmount_(row, target.amountColumns)
    };
    item.fingerprint = itemFingerprint_(item);
    items.push(item);
  }
  return items;
}

/**
 * First non-empty text value among the given 1-based columns.
 * @param {Array<*>} row Row values, index 0 = column A.
 * @param {Array<number>} columns Columns to try, in priority order.
 * @return {string} Trimmed text, or '' when every candidate is empty.
 */
function firstText_(row, columns) {
  for (var i = 0; i < columns.length; i++) {
    var cell = row[columns[i] - 1];
    if (cell === null || cell === undefined) continue;
    var text = cell.toString().trim();
    if (text !== '') return text;
  }
  return '';
}

/**
 * First usable amount among the given 1-based columns. Numbers win outright;
 * text is only parsed once no numeric cell is left, so "Rp 1.500" still counts.
 * @param {Array<*>} row Row values, index 0 = column A.
 * @param {Array<number>} columns Columns to try, in priority order.
 * @return {number} The amount, or 0 when nothing parses.
 */
function firstAmount_(row, columns) {
  var i;
  for (i = 0; i < columns.length; i++) {
    var value = row[columns[i] - 1];
    if (typeof value === 'number' && isFinite(value)) return value;
  }
  for (i = 0; i < columns.length; i++) {
    var text = row[columns[i] - 1];
    if (text === null || text === undefined || text === '') continue;
    var parsed = parseFloat(text.toString().replace(/[^\d.-]/g, ''));
    if (!isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * Identity of a row as shown to the user, independent of its position.
 *
 * Compared again just before deleting, so a row that moved while the dialog was
 * open is skipped instead of taking an innocent neighbour's place.
 *
 * @param {{description: string, amount: number}} item Row detail.
 * @return {string} Fingerprint key.
 */
function itemFingerprint_(item) {
  return String(item.description) + KEY_SEPARATOR + String(item.amount);
}

/* ==========================================================================
 * Deletion
 * ========================================================================== */

/**
 * Deletes every settled row in every configured sheet, without asking.
 *
 * This is the trigger entry point: takes the document lock so a scheduled run
 * and a manual run can never delete rows from under each other, never touches
 * the UI, and reports failures instead of throwing so one bad sheet cannot
 * abort the rest.
 *
 * @return {{success: boolean, deleted: number, sheets: Array<string>,
 *           skipped: Array<string>, error: (string|undefined)}} What happened.
 */
function deleteCheckedRows() {
  var context = 'deleteCheckedRows';

  return withCleanupLock_(context, function (ss) {
    var result = { success: true, deleted: 0, sheets: [], skipped: [] };

    for (var i = 0; i < ROW_CLEANUP_TARGETS.length; i++) {
      var target = ROW_CLEANUP_TARGETS[i];
      var sheet = ss.getSheetByName(target.sheetName);

      if (!sheet) {
        result.skipped.push(target.sheetName + ' (missing)');
        continue;
      }

      try {
        var items = findCheckedItems_(sheet, target);
        if (!items.length) {
          result.skipped.push(target.sheetName + ' (nothing checked)');
          continue;
        }
        deleteRowsDescending_(sheet, items.map(function (item) { return item.rowIndex; }));
        if (target.restoreGrid) restoreCcTrackerRows_(sheet);
        result.deleted += items.length;
        result.sheets.push(target.sheetName + ' (' + items.length + ')');
      } catch (sheetError) {
        logError(context, sheetError);
        result.success = false;
        result.error = sheetError.toString();
        result.skipped.push(target.sheetName + ' (failed)');
      }
    }

    if (result.deleted > 0) SpreadsheetApp.flush();
    logInfo(context, 'Deleted ' + result.deleted + ' row(s). Cleaned: ' +
        (result.sheets.join(', ') || 'none') + ' | Skipped: ' +
        (result.skipped.join(', ') || 'none'));
    return result;
  });
}

/**
 * Deletes exactly the rows the user confirmed in the dialog.
 *
 * Every row is re-read under the lock and only deleted when it is still ticked
 * AND still carries the description/amount that was shown. Anything that no
 * longer matches is left alone and counted as stale, so a sheet edited while the
 * dialog was open can never lose the wrong row.
 *
 * @param {Array<Object>|string} confirmedItems Items from the dialog (array or
 *     JSON string), each with sheetName, rowIndex and fingerprint.
 * @return {{success: boolean, deleted: number, stale: number,
 *           sheets: Array<string>, skipped: Array<string>,
 *           error: (string|undefined)}} What happened.
 */
function deleteConfirmedRows(confirmedItems) {
  var context = 'deleteConfirmedRows';

  if (typeof confirmedItems === 'string') {
    try {
      confirmedItems = JSON.parse(confirmedItems);
    } catch (parseError) {
      logError(context, parseError);
      return { success: false, deleted: 0, stale: 0, sheets: [], skipped: [],
               error: 'Could not read the confirmed selection.' };
    }
  }
  if (!confirmedItems || !confirmedItems.length) {
    return { success: false, deleted: 0, stale: 0, sheets: [], skipped: [],
             error: 'No rows were confirmed.' };
  }
  logInfo(context, 'Confirmed ' + confirmedItems.length + ' row(s) for deletion.');

  return withCleanupLock_(context, function (ss) {
    var result = { success: true, deleted: 0, stale: 0, sheets: [], skipped: [] };

    for (var i = 0; i < ROW_CLEANUP_TARGETS.length; i++) {
      var target = ROW_CLEANUP_TARGETS[i];

      var wanted = Object.create(null);
      var wantedCount = 0;
      for (var c = 0; c < confirmedItems.length; c++) {
        var confirmed = confirmedItems[c];
        if (!confirmed || confirmed.sheetName !== target.sheetName) continue;
        wanted[String(confirmed.rowIndex)] = String(confirmed.fingerprint);
        wantedCount++;
      }
      if (!wantedCount) continue;

      var sheet = ss.getSheetByName(target.sheetName);
      if (!sheet) {
        result.skipped.push(target.sheetName + ' (missing)');
        result.stale += wantedCount;
        continue;
      }

      try {
        var rows = [];
        var live = findCheckedItems_(sheet, target);
        for (var l = 0; l < live.length; l++) {
          var key = String(live[l].rowIndex);
          if (wanted[key] !== undefined && wanted[key] === live[l].fingerprint) {
            rows.push(live[l].rowIndex);
            delete wanted[key];
          }
        }

        var stale = wantedCount - rows.length;
        result.stale += stale;
        if (stale > 0) {
          logInfo(context, stale + ' confirmed row(s) in ' + target.sheetName +
              ' no longer match and were left alone.');
        }

        if (!rows.length) {
          result.skipped.push(target.sheetName + ' (nothing left to delete)');
          continue;
        }
        deleteRowsDescending_(sheet, rows);
        if (target.restoreGrid) restoreCcTrackerRows_(sheet);
        result.deleted += rows.length;
        result.sheets.push(target.sheetName + ' (' + rows.length + ')');
      } catch (sheetError) {
        logError(context, sheetError);
        result.success = false;
        result.error = sheetError.toString();
        result.skipped.push(target.sheetName + ' (failed)');
      }
    }

    if (result.deleted > 0) SpreadsheetApp.flush();
    logInfo(context, 'Deleted ' + result.deleted + ' row(s), skipped ' +
        result.stale + ' stale row(s).');
    return result;
  });
}

/**
 * Runs a cleanup body while holding the document lock, converting a lost lock or
 * an unexpected failure into a reported result rather than a thrown error.
 *
 * @param {string} context Calling function name, for the log.
 * @param {function(Spreadsheet): Object} body Work to run under the lock.
 * @return {Object} The body's result, or a failure result.
 */
function withCleanupLock_(context, body) {
  var lock = getLock_();
  if (!lock.tryLock(ROW_CLEANUP_LOCK_TIMEOUT_MS)) {
    logInfo(context, 'Could not obtain the document lock; another run is active.');
    return { success: false, deleted: 0, stale: 0, sheets: [], skipped: [],
             error: 'Another cleanup is already running. Try again in a moment.' };
  }

  try {
    return body(getBook_());
  } catch (e) {
    logError(context, e);
    return { success: false, deleted: 0, stale: 0, sheets: [], skipped: [],
             error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

/* ==========================================================================
 * Menu entry point
 * ========================================================================== */

/**
 * Menu entry point: lists every settled transaction in a dialog for review, and
 * deletes nothing until the user confirms there.
 */
function runDeleteCheckedRows() {
  var context = 'runDeleteCheckedRows';

  try {
    var ss = getBook_();
    var items = [];
    var missing = [];

    for (var i = 0; i < ROW_CLEANUP_TARGETS.length; i++) {
      var target = ROW_CLEANUP_TARGETS[i];
      var sheet = ss.getSheetByName(target.sheetName);
      if (!sheet) {
        missing.push(target.sheetName);
        continue;
      }
      items = items.concat(findCheckedItems_(sheet, target));
    }

    if (missing.length) {
      SpreadsheetApp.getUi().alert('Rows Deletion',
          'Sheet not found: ' + missing.join(', ') + '. Check the tab name.',
          SpreadsheetApp.getUi().ButtonSet.OK);
      return;
    }

    if (!items.length) {
      ss.toast('No rows are checked as Paid or Cancelled.', 'Rows Deletion', 5);
      logInfo(context, 'Nothing checked; dialog not opened.');
      return;
    }

    var template = HtmlService.createTemplateFromFile('RowDeletionDialog');
    template.itemsLiteral = toScriptLiteral_(items);

    var html = template.evaluate()
        .setWidth(DIALOG_WIDTH)
        .setHeight(DIALOG_HEIGHT)
        .setTitle('Confirm Rows Deletion');

    SpreadsheetApp.getUi().showModalDialog(html, '🗑️ Rows Deletion for Paid/Cancelled');
    logInfo(context, 'Dialog opened with ' + items.length + ' candidate row(s).');
  } catch (e) {
    logError(context, e);
    try {
      getBook_()
          .toast('Could not open the review dialog: ' + e.toString(), 'Rows Deletion', 8);
    } catch (toastError) {
      logError(context, toastError);
    }
  }
}
