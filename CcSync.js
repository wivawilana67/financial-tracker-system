/**
 * CcSync.js — credit card transaction sync and the CC Tracker checklist tools.
 *
 * One Gmail fetch feeds two sheets:
 *   CC Tracker       the weekly working sheet: transactions written straight into
 *                    A:G, with Select / Paid / Cancelled / Note in H:K. Deleted and
 *                    rebuilt every week, so a missing tab is skipped, not an error.
 *   CC Transaction   the permanent log: one flat table, every card, never cleared.
 *
 * Adding another card: append an entry to CC_SOURCES with its own Gmail query
 * and a parser that returns {timestamp, card, merchant, type, amount, currency}
 * (or {error: '...'} when the email cannot be read). Everything else — dedupe,
 * both sheets, the menu — picks it up unchanged.
 *
 * Trigger-safe entry points: runBCA_Yesterday, runBCA_Today. The function names
 * are kept from the BCA-only version so existing triggers keep working.
 */

// ==========================================
// ⚙️ CONFIGURATION SETTINGS
// ==========================================

// --- CC Tracker (weekly working sheet) ---
var CC_TRACKER_SHEET = 'CC Tracker';
var CC_TRACKER_HEADER_ROW = 7;   // The row where the headers sit
var CC_TRACKER_FIRST_DATA_ROW = 8;
var CC_TRACKER_START_COL = 1;    // Column A — the sync writes straight into the table
var CC_TRACKER_NUM_COLS = 7;     // A..G: Datetime, Bank, Card, Description, Type, Amount, Currency
/**
 * 1-based columns of the tracker table A:K. Change a letter here, in
 * RowCleanup.js and in buildBcaTrackerSheet_ together.
 */
var CC_TRACKER_COLS = {
  CARD: 3,          // C
  DESCRIPTION: 4,   // D
  AMOUNT: 6,        // F
  SELECT: 8,        // H
  PAID: 9,          // I
  LAST: 11          // K (Note) — the dedupe and sort move A..K as whole rows
};

/** Font for every data row of CC Tracker and CC Transaction. */
var CC_DATA_FONT = 'Calibri';
/** Date-time and amount formats shared by both sheets. */
var CC_DATETIME_NUMBER_FORMAT = 'yyyy-mm-dd hh:mm:ss';
var CC_AMOUNT_NUMBER_FORMAT = '#,##0';

/**
 * Number format per tracker column A..K (null = leave alone, the checkboxes).
 * Text columns are plain text ('@') so a merchant such as "7-11" or a note such
 * as "12/5" is never read as a date. Applied before every write and re-applied
 * to the whole table, because sorting and row deletion move cell formats around.
 */
var CC_TRACKER_NUMBER_FORMATS = [
  CC_DATETIME_NUMBER_FORMAT, '@', '@', '@', '@', CC_AMOUNT_NUMBER_FORMAT, '@', null, null, null, '@'
];

// --- CC Transaction (permanent log) ---
/** Permanent transaction log. Header on row 1, data from row 2. */
var CC_TRANSACTION_SHEET = 'CC Transaction';
var CC_TRANSACTION_HEADERS = [
  'Datetime', 'Bank', 'Card Number', 'Description', 'Type', 'Amount', 'Currency Code'
];
/** Number format per log column A..G; see CC_TRACKER_NUMBER_FORMATS. */
var CC_TRANSACTION_NUMBER_FORMATS = [
  CC_DATETIME_NUMBER_FORMAT, '@', '@', '@', '@', CC_AMOUNT_NUMBER_FORMAT, '@'
];

/** Every timestamp is read and written in this zone (must match the spreadsheet). */
var CC_TIMEZONE = 'Asia/Jakarta';
var CC_DATETIME_FORMAT = 'yyyy-MM-dd HH:mm:ss';

/** Gmail search padding around the requested range: emails can arrive late. */
var CC_SEARCH_DAYS_BEFORE = 5;
var CC_SEARCH_DAYS_AFTER = 1;
var CC_SEARCH_PAGE_SIZE = 100;

/** One entry per card issuer. `bank` is what lands in the CC Transaction Bank column. */
var CC_SOURCES = [
  {
    bank: 'BCA',
    query: '(label:"Notif CC BCA" OR subject:"Credit Card Transaction Notification")',
    parse: parseBcaCcEmail_
  }
];
// ==========================================

/* ==========================================================================
 * Menu / trigger wrappers
 * ========================================================================== */

/** Syncs yesterday (Asia/Jakarta). Safe for a daily time-driven trigger. */
function runBCA_Yesterday() {
  var yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  var dateString = Utilities.formatDate(yesterday, CC_TIMEZONE, 'yyyy-MM-dd');
  runCcSyncWithToast_(dateString, dateString);
}

/** Syncs today (Asia/Jakarta). */
function runBCA_Today() {
  var dateString = Utilities.formatDate(new Date(), CC_TIMEZONE, 'yyyy-MM-dd');
  runCcSyncWithToast_(dateString, dateString);
}

/** Prompts for a date range, then syncs it. */
function runBCA_CustomPrompt() {
  var ui = SpreadsheetApp.getUi();
  var startResponse = ui.prompt('Sync Custom Range', 'Enter START date (YYYY-MM-DD):', ui.ButtonSet.OK_CANCEL);
  if (startResponse.getSelectedButton() !== ui.Button.OK) return;
  var endResponse = ui.prompt('Sync Custom Range', 'Enter END date (YYYY-MM-DD):', ui.ButtonSet.OK_CANCEL);
  if (endResponse.getSelectedButton() !== ui.Button.OK) return;

  runCcSyncWithToast_(startResponse.getResponseText().trim(), endResponse.getResponseText().trim());
}

/**
 * Runs a sync into both sheets and reports the outcome as a toast.
 * @param {string} startDate yyyy-MM-dd, inclusive.
 * @param {string} endDate yyyy-MM-dd, inclusive.
 */
function runCcSyncWithToast_(startDate, endDate) {
  var context = 'runCcSyncWithToast_';
  var ss = getBook_();
  try {
    var report = syncCcTransactions_(startDate, endDate, { tracker: true, transaction: true });
    ss.toast(describeCcSyncReport_(report), '💳 CC Sync Report', 10);
  } catch (e) {
    logError(context, e);
    ss.toast('CC sync failed: ' + (e.message || e), 'Error', 10);
    throw e;
  }
}

/* ==========================================================================
 * Core sync
 * ========================================================================== */

/**
 * Fetches card transactions for a date range and writes them to the chosen sheets.
 * @param {string} startDate yyyy-MM-dd, inclusive.
 * @param {string} endDate yyyy-MM-dd, inclusive.
 * @param {{tracker: boolean, transaction: boolean}} targets Sheets to write.
 * @return {Object} Report: fetched rows plus one entry per sheet written.
 */
function syncCcTransactions_(startDate, endDate, targets) {
  var context = 'syncCcTransactions_';
  logInfo(context, 'range=' + startDate + '..' + endDate + ' targets=' + JSON.stringify(targets));
  try {
    var range = parseCcDateRange_(startDate, endDate);
    var fetched = fetchCcTransactions_(range);
    var ss = getBook_();

    var report = { range: startDate + ' → ' + endDate, fetched: fetched.rows.length,
        incomingDuplicates: fetched.incomingDuplicates, failed: fetched.failed };
    if (targets.tracker) report.tracker = writeCcTracker_(ss, fetched.rows);
    if (targets.transaction) report.transaction = writeCcTransactionLog_(ss, fetched.rows);

    logInfo(context, JSON.stringify(report));
    return report;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * @param {string} startDate yyyy-MM-dd.
 * @param {string} endDate yyyy-MM-dd.
 * @return {{start: Date, end: Date, startStr: string, endStr: string}} Validated range.
 */
function parseCcDateRange_(startDate, endDate) {
  var pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(startDate) || !pattern.test(endDate)) {
    throw new Error('Dates must be YYYY-MM-DD (received "' + startDate + '" and "' + endDate + '").');
  }
  if (startDate > endDate) {
    throw new Error('Start date ' + startDate + ' is after end date ' + endDate + '.');
  }
  return {
    start: new Date(startDate + 'T00:00:00+07:00'),
    end: new Date(endDate + 'T23:59:59+07:00'),
    startStr: startDate.replace(/-/g, '/'),
    endStr: endDate.replace(/-/g, '/')
  };
}

/**
 * Reads every source's notification emails received inside the range.
 * @param {Object} range From parseCcDateRange_.
 * @return {{rows: Array<Object>, incomingDuplicates: number, failed: number}}
 *     Unique transactions, oldest first.
 */
function fetchCcTransactions_(range) {
  var dayMs = 24 * 60 * 60 * 1000;
  var searchStart = Utilities.formatDate(
      new Date(range.start.getTime() - CC_SEARCH_DAYS_BEFORE * dayMs), CC_TIMEZONE, 'yyyy/MM/dd');
  var searchEnd = Utilities.formatDate(
      new Date(range.end.getTime() + CC_SEARCH_DAYS_AFTER * dayMs), CC_TIMEZONE, 'yyyy/MM/dd');

  var rows = [];
  var failed = 0;

  CC_SOURCES.forEach(function (source) {
    var threads = searchAllThreads_(source.query + ' after:' + searchStart + ' before:' + searchEnd);
    var state = { lastCard: 'Unknown', lastMerchant: 'Unknown' };

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        var received = msg.getDate();
        var receivedStr = Utilities.formatDate(received, CC_TIMEZONE, 'yyyy/MM/dd');
        if (receivedStr < range.startStr || receivedStr > range.endStr) return;

        var parsed = source.parse(cleanEmailBody_(msg.getBody()), received, state);
        if (parsed.error) {
          failed++;
          rows.push({ timestamp: received, bank: source.bank, card: 'FAILED TO READ',
              merchant: parsed.error, type: 'ERROR', amount: 0, currency: 'ERR' });
          return;
        }
        parsed.bank = source.bank;
        rows.push(parsed);
      });
    });
    logInfo('fetchCcTransactions_', source.bank + ': threads=' + threads.length);
  });

  // The same notification can sit in two threads; keep the first copy.
  var seen = new Set();
  var unique = rows.filter(function (row) {
    var key = ccFingerprint_(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort(function (a, b) { return a.timestamp.getTime() - b.timestamp.getTime(); });

  return { rows: unique, incomingDuplicates: rows.length - unique.length, failed: failed };
}

/**
 * GmailApp.search caps a single call, so page through until a short page.
 * @param {string} query Gmail search query.
 * @return {Array<GmailThread>} Every matching thread.
 */
function searchAllThreads_(query) {
  var all = [];
  for (var start = 0; ; start += CC_SEARCH_PAGE_SIZE) {
    var page = GmailApp.search(query, start, CC_SEARCH_PAGE_SIZE);
    all = all.concat(page);
    if (page.length < CC_SEARCH_PAGE_SIZE) return all;
  }
}

/**
 * @param {string} html Raw email body.
 * @return {string} Plain text with collapsed whitespace.
 */
function cleanEmailBody_(html) {
  return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/ig, ' ')
      .replace(/\s+/g, ' ');
}

/**
 * Parses one BCA "Credit Card Transaction Notification" email.
 * @param {string} body Cleaned email text.
 * @param {Date} received When Gmail received it (fallback timestamp).
 * @param {{lastCard: string, lastMerchant: string}} state Carried between emails
 *     of one sync, for notifications that omit a field.
 * @return {Object} Transaction, or {error: string} when the amount is unreadable.
 */
function parseBcaCcEmail_(body, received, state) {
  var amountMatch = body.match(/Sejumlah\s*:\s*(Rp|IDR|[A-Z]{3})\s*([\d\.,]+)/i) ||
      body.match(/Sejumlah\s*:\s*([A-Za-z]+)?\s*([\d\.,]+)/i);
  if (!amountMatch) return { error: body.substring(0, 75) + '...' };

  var timestamp = received;
  var exactDate = body.match(/Pada Tanggal\s*:\s*(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2}:\d{2})/i);
  if (exactDate) {
    var d = exactDate[1].split('-');
    timestamp = new Date(d[2] + '-' + d[1] + '-' + d[0] + 'T' + exactDate[2] + '+07:00');
  }

  var cardMatch = body.match(/Nomor Kartu\s*:\s*([0-9X]+)/i);
  var merchantMatch = body.match(/Merchant \/ ATM\s*:\s*(.*?)(?=Jenis Transaksi)/i);
  var card = cardMatch ? cardMatch[1].trim() : state.lastCard;
  var merchant = merchantMatch ? merchantMatch[1].trim() : state.lastMerchant;
  if (card !== 'Unknown') state.lastCard = card;
  if (merchant !== 'Unknown') state.lastMerchant = merchant;

  var type = /Void|Reversal|Batal/i.test(body) ? 'Void' : 'Transaction';
  var rawCurrency = amountMatch[1] ? amountMatch[1].trim().toUpperCase() : 'IDR';
  var amount = parseFloat(amountMatch[2].trim().replace(/\./g, '').replace(/,/g, '.'));
  if (type === 'Void') amount = -Math.abs(amount);

  return { timestamp: timestamp, card: card, merchant: merchant, type: type,
      amount: amount, currency: rawCurrency === 'RP' ? 'IDR' : rawCurrency };
}

/**
 * Identity of a transaction across runs: every column CC Transaction stores.
 * @param {Object} row Transaction object.
 * @return {string} Fingerprint.
 */
function ccFingerprint_(row) {
  return [ccDatetimeString_(row.timestamp), String(row.bank).trim(), String(row.card).trim(),
      String(row.merchant).trim(), String(row.type).trim(), Number(row.amount),
      String(row.currency).trim()].join(KEY_SEPARATOR);
}

/**
 * @param {*} value Date object or text read back from a sheet.
 * @return {string} yyyy-MM-dd HH:mm:ss in CC_TIMEZONE.
 */
function ccDatetimeString_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, CC_TIMEZONE, CC_DATETIME_FORMAT);
  return String(value).trim();
}

/**
 * Gives a block of data rows, from column A, the shared CC look: CC_DATA_FONT
 * across every column and one number format per column.
 * @param {Sheet} sheet Target sheet.
 * @param {number} firstRow First row of the block.
 * @param {number} numRows Rows in the block.
 * @param {Array<?string>} formats Format per column; null leaves that column's format alone.
 */
function applyCcNumberFormats_(sheet, firstRow, numRows, formats) {
  if (numRows < 1) return;
  sheet.getRange(firstRow, 1, numRows, formats.length).setFontFamily(CC_DATA_FONT);
  formats.forEach(function (format, i) {
    if (format) sheet.getRange(firstRow, i + 1, numRows, 1).setNumberFormat(format);
  });
}

/* ==========================================================================
 * Sheet writers
 * ========================================================================== */

/**
 * Appends only the transactions the CC Tracker does not already hold, then
 * sorts the table by Datetime.
 *
 * Duplicates are filtered before writing (same fingerprint as CC Transaction),
 * never written and removed afterwards: Sheets' Remove duplicates shifts cells
 * up inside its range, which strips the formats and checkboxes off the rows
 * just below the data.
 *
 * The sort moves whole rows A..K, so Select / Paid / Cancelled / Note stay with
 * their transaction when a late, older one is sorted into the middle.
 *
 * A missing tab is reported, not thrown: the tracker is deleted every week and
 * the log must still be written.
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {Array<Object>} rows Transactions from fetchCcTransactions_.
 * @return {Object} {written, sheetDuplicates, saved} or {skipped: reason}.
 */
function writeCcTracker_(ss, rows) {
  var sheet = ss.getSheetByName(CC_TRACKER_SHEET);
  if (!sheet) {
    logInfo('writeCcTracker_', 'Tab "' + CC_TRACKER_SHEET + '" not found; skipped.');
    return { skipped: 'tab "' + CC_TRACKER_SHEET + '" not found' };
  }
  if (!rows.length) return { written: 0, sheetDuplicates: 0, saved: 0 };

  var first = CC_TRACKER_FIRST_DATA_ROW;
  var bottom = getLastRowInTargetCol(sheet, CC_TRACKER_START_COL, CC_TRACKER_HEADER_ROW);
  var existing = new Set();
  if (bottom >= first) {
    sheet.getRange(first, CC_TRACKER_START_COL, bottom - first + 1, CC_TRACKER_NUM_COLS).getValues()
        .forEach(function (r) {
          existing.add(ccFingerprint_({ timestamp: r[0], bank: r[1], card: r[2], merchant: r[3],
              type: r[4], amount: r[5], currency: r[6] }));
        });
  }

  var fresh = rows.filter(function (row) { return !existing.has(ccFingerprint_(row)); });
  if (fresh.length) {
    var values = fresh.map(function (row) {
      return [ccDatetimeString_(row.timestamp), row.bank, row.card, row.merchant, row.type,
          row.amount, row.currency];
    });
    ensureRowCapacity_(sheet, bottom + values.length);
    applyCcNumberFormats_(sheet, bottom + 1, values.length, CC_TRACKER_NUMBER_FORMATS);
    sheet.getRange(bottom + 1, CC_TRACKER_START_COL, values.length, CC_TRACKER_NUM_COLS).setValues(values);

    var rowWidth = CC_TRACKER_COLS.LAST - CC_TRACKER_START_COL + 1;
    sheet.getRange(first, CC_TRACKER_START_COL, bottom - first + 1 + values.length, rowWidth)
        .sort(CC_TRACKER_START_COL);
    restoreCcTrackerRows_(sheet);
  }

  return { written: rows.length, sheetDuplicates: rows.length - fresh.length, saved: fresh.length };
}

/**
 * Keeps the CC Tracker grid whole after rows are deleted or appended.
 *
 * "Rows Deletion for Paid/Cancelled" deletes whole rows, so every weekly clean
 * shrinks the template grid; rows the sync adds past the end arrive bare. This
 * tops the grid back up to the template size, gives every row that has no
 * checkbox (at the end or in the middle) row 8's formats and fresh H:J
 * checkboxes, re-applies CC_TRACKER_NUMBER_FORMATS to every row, and points
 * the fill-colour rules at full rows A8:K down to the last row.
 *
 * Rows that already have a checkbox are never touched, so no tick is reset.
 * @param {Sheet} sheet The CC Tracker sheet.
 */
function restoreCcTrackerRows_(sheet) {
  var context = 'restoreCcTrackerRows_';
  try {
    var first = CC_TRACKER_FIRST_DATA_ROW;
    var width = CC_TRACKER_COLS.LAST;
    var before = sheet.getMaxRows();
    if (before < TEMPLATE_BCA_LAST_ROW) sheet.insertRowsAfter(before, TEMPLATE_BCA_LAST_ROW - before);
    var last = sheet.getMaxRows();

    // A row with no Select checkbox is bare, wherever it sits: past the end
    // after an append, or anywhere a range operation shifted cells around.
    var rules = sheet.getRange(first, CC_TRACKER_COLS.SELECT, last - first + 1, 1).getDataValidations();
    var repaired = [];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0]) continue;
      var j = i;
      while (j + 1 < rules.length && !rules[j + 1][0]) j++;
      var from = first + i;
      var count = j - i + 1;
      // Row 8 is the format source, so it can only take checkboxes itself.
      if (from > first) {
        sheet.getRange(first, 1, 1, width).copyTo(sheet.getRange(from, 1, count, width),
            SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      }
      sheet.getRange(from, CC_TRACKER_COLS.SELECT, count, 3).insertCheckboxes();
      repaired.push(from + (count > 1 ? '-' + (from + count - 1) : ''));
      i = j;
    }

    applyCcNumberFormats_(sheet, first, last - first + 1, CC_TRACKER_NUMBER_FORMATS);

    var full = sheet.getRange(first, 1, last - first + 1, width);
    sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().map(function (rule) {
      return rule.copy().setRanges([full]).build();
    }));
    logInfo(context, 'grid rows=' + last + (repaired.length ? ', repaired rows ' + repaired.join(', ') : ''));
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Appends only transactions the log does not already hold, then sorts the log
 * by Datetime. Columns to the right of the seven managed ones (notes you add
 * by hand) are sorted with their row, never overwritten.
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {Array<Object>} rows Transactions from fetchCcTransactions_.
 * @return {{added: number, alreadyLogged: number}} Outcome.
 */
function writeCcTransactionLog_(ss, rows) {
  var sheet = ensureCcTransactionSheet_(ss);
  var lastRow = getLastRowByColumnA(sheet);
  var width = CC_TRANSACTION_HEADERS.length;

  var existing = new Set();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, width).getValues().forEach(function (r) {
      existing.add(ccFingerprint_({ timestamp: r[0], bank: r[1], card: r[2], merchant: r[3],
          type: r[4], amount: r[5], currency: r[6] }));
    });
  }

  var fresh = rows.filter(function (row) { return !existing.has(ccFingerprint_(row)); });
  if (fresh.length) {
    var values = fresh.map(function (row) {
      return [ccDatetimeString_(row.timestamp), row.bank, row.card, row.merchant,
          row.type, row.amount, row.currency];
    });
    ensureRowCapacity_(sheet, lastRow + values.length);
    applyCcNumberFormats_(sheet, lastRow + 1, values.length, CC_TRANSACTION_NUMBER_FORMATS);
    sheet.getRange(lastRow + 1, 1, values.length, width).setValues(values);
    sheet.getRange(2, 1, lastRow - 1 + values.length, sheet.getLastColumn()).sort(1);
    applyCcNumberFormats_(sheet, 2, lastRow - 1 + values.length, CC_TRANSACTION_NUMBER_FORMATS);
  }

  return { added: fresh.length, alreadyLogged: rows.length - fresh.length };
}

/**
 * Returns the CC Transaction tab, creating it with headers when missing.
 * @param {Spreadsheet} ss Active spreadsheet.
 * @return {Sheet} The log sheet.
 */
function ensureCcTransactionSheet_(ss) {
  var sheet = ss.getSheetByName(CC_TRANSACTION_SHEET);
  if (sheet) return sheet;

  logInfo('ensureCcTransactionSheet_', 'Creating "' + CC_TRANSACTION_SHEET + '".');
  sheet = ss.insertSheet(CC_TRANSACTION_SHEET);
  buildCcTransactionSheet_(ss, sheet);
  return sheet;
}

/**
 * Header row, frozen pane and column formats for the CC Transaction log. Also
 * the template builder for the tab (see TemplateGenerator.js).
 * @param {Spreadsheet} ss Unused; matches the template builder signature.
 * @param {Sheet} sheet Sheet to format.
 */
function buildCcTransactionSheet_(ss, sheet) {
  var width = CC_TRANSACTION_HEADERS.length;
  // Same grid as the source workbook: 1000 rows, the seven log columns only.
  fitTemplateSize_(sheet, TEMPLATE_CC_TRANSACTION_SIZE[0], TEMPLATE_CC_TRANSACTION_SIZE[1]);
  sheet.getRange(1, 1, 1, width).setValues([CC_TRANSACTION_HEADERS])
      .setFontWeight('bold').setBackground('#333333').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  applyCcNumberFormats_(sheet, 2, sheet.getMaxRows() - 1, CC_TRANSACTION_NUMBER_FORMATS);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 360);
}

/**
 * @param {Object} report From syncCcTransactions_.
 * @return {string} Toast text.
 */
function describeCcSyncReport_(report) {
  if (!report.fetched) return 'No transactions found for ' + report.range + '.';

  var lines = ['Fetched: ' + report.fetched + ' (' + report.range + ')'];
  if (report.incomingDuplicates) lines.push('Duplicate emails blocked: ' + report.incomingDuplicates);
  if (report.failed) lines.push('⚠️ Unreadable emails: ' + report.failed);

  var t = report.tracker;
  if (t) {
    lines.push(t.skipped ? 'CC Tracker: skipped (' + t.skipped + ')'
        : 'CC Tracker: ' + t.saved + ' saved' + (t.sheetDuplicates ? ', ' + t.sheetDuplicates + ' duplicates removed' : ''));
  }
  var log = report.transaction;
  if (log) {
    lines.push('CC Transaction: ' + log.added + ' added' +
        (log.alreadyLogged ? ', ' + log.alreadyLogged + ' already logged' : ''));
  }
  return lines.join('\n');
}

/**
 * Last non-empty row in one column, never above the header row.
 */
function getLastRowInTargetCol(sheet, colIndex, headerRow) {
  var data = sheet.getRange(1, colIndex, sheet.getMaxRows(), 1).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (data[i][0] !== "" && data[i][0] !== null) {
      return (i + 1 > headerRow) ? (i + 1) : headerRow;
    }
  }
  return headerRow;
}

/* ==========================================================================
 * CC Tracker checklist tools
 * ========================================================================== */

/**
 * FEATURE: Paid by Selection
 * Scans the Select column (H) for checked items, collects transaction details (row index, card number, description, amount),
 * and opens the confirmation modal dialog (PaidBySelectionDialog.html).
 */
function runPaidBySelection() {
  Logger.log("Entering runPaidBySelection");
  try {
    var ss = getBook_();
    var sheet = ss.getSheetByName(CC_TRACKER_SHEET);
    if (!sheet) {
      getBook_().toast("Error: Tab '" + CC_TRACKER_SHEET + "' not found. Check spelling.", "Failed");
      return;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < CC_TRACKER_FIRST_DATA_ROW) {
      getBook_().toast("No data found to process.", "Finished");
      return;
    }

    var selectedItems = getSelectedBcaCcItems();

    if (selectedItems.length === 0) {
      getBook_().toast("No checked selections found to process.", "Finished");
      return;
    }

    Logger.log("Found " + selectedItems.length + " selected item(s). Opening confirmation dialog.");

    var template = HtmlService.createTemplateFromFile('PaidBySelectionDialog');
    template.selectedItemsJson = JSON.stringify(selectedItems);

    var html = template.evaluate()
        .setWidth(680)
        .setHeight(520)
        .setTitle('Confirm Paid by Selection');

    SpreadsheetApp.getUi().showModalDialog(html, '💳 Confirm Paid by Selection');
  } catch (e) {
    Logger.log("CRITICAL ERROR in runPaidBySelection: " + e.toString() + "\nStack: " + e.stack);
    getBook_().toast("Error launching confirmation dialog: " + e.toString(), "Error");
  }
}

/**
 * Returns an array of selected items from the Select column (H).
 * Serves as both internal logic helper and client-side google.script.run endpoint.
 */
function getSelectedBcaCcItems() {
  Logger.log("Entering getSelectedBcaCcItems");
  try {
    var ss = getBook_();
    var sheet = ss.getSheetByName(CC_TRACKER_SHEET);
    if (!sheet) return [];

    var C = CC_TRACKER_COLS;
    var startRow = CC_TRACKER_FIRST_DATA_ROW;
    var lastRow = sheet.getLastRow();
    if (lastRow < startRow) return [];

    var numRows = lastRow - startRow + 1;
    var width = Math.min(C.LAST, sheet.getMaxColumns());
    var values = sheet.getRange(startRow, 1, numRows, width).getValues();
    var selectedItems = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];

      if (row[C.SELECT - 1] === true) {
        var rIdx = startRow + i;
        var card = row[C.CARD - 1];
        var desc = row[C.DESCRIPTION - 1];
        var cardNum = card ? card.toString().trim() : "N/A";
        var descStr = desc ? desc.toString().trim() : (row[0] ? row[0].toString().trim() : "-");

        var amt = row[C.AMOUNT - 1];
        var amtVal = 0;
        if (typeof amt === 'number' && !isNaN(amt)) {
          amtVal = amt;
        } else if (amt) {
          var parsedP = parseFloat(amt.toString().replace(/[^\d.-]/g, ''));
          if (!isNaN(parsedP)) amtVal = parsedP;
        }

        selectedItems.push({
          rowIndex: rIdx,
          cardNumber: cardNum,
          description: descStr,
          amount: amtVal
        });
      }
    }

    Logger.log("getSelectedBcaCcItems found " + selectedItems.length + " item(s)");
    return selectedItems;
  } catch (e) {
    Logger.log("Error in getSelectedBcaCcItems: " + e.toString());
    return [];
  }
}

/**
 * Executes the payment status update and clears selection checkboxes in batch.
 * @param {Array<number>|string} targetRowIndexes Array or JSON string of row indices to process.
 */
function processPaidAndClearSelection(targetRowIndexes) {
  Logger.log("Entering processPaidAndClearSelection with targetRowIndexes: " + JSON.stringify(targetRowIndexes));
  try {
    if (typeof targetRowIndexes === 'string') {
      try {
        targetRowIndexes = JSON.parse(targetRowIndexes);
      } catch (err) {
        Logger.log("Could not parse targetRowIndexes string: " + err.toString());
      }
    }

    if (!targetRowIndexes || !Array.isArray(targetRowIndexes) || targetRowIndexes.length === 0) {
      return { success: false, message: "No rows specified for processing." };
    }

    var ss = getBook_();
    var sheet = ss.getSheetByName(CC_TRACKER_SHEET);
    if (!sheet) {
      throw new Error("Tab '" + CC_TRACKER_SHEET + "' not found.");
    }

    var startRow = CC_TRACKER_FIRST_DATA_ROW;
    var lastRow = sheet.getLastRow();
    if (lastRow < startRow) {
      return { success: false, message: "No data rows available." };
    }

    var numRows = lastRow - startRow + 1;
    var range = sheet.getRange(startRow, CC_TRACKER_COLS.SELECT, numRows, 2); // Select and Paid (adjacent)
    var values = range.getValues();
    var changeCounter = 0;

    var targetSet = new Set();
    targetRowIndexes.forEach(function(r) {
      targetSet.add(Number(r));
    });

    for (var i = 0; i < values.length; i++) {
      var currentRowNum = startRow + i;
      if (targetSet.has(currentRowNum)) {
        values[i][0] = false; // Clear Select
        values[i][1] = true;  // Mark Paid
        changeCounter++;
      }
    }

    if (changeCounter > 0) {
      range.setValues(values);
      getBook_().toast("Successfully updated " + changeCounter + " row(s) to Paid and cleared selection.", "💳 Update Success");
    } else {
      getBook_().toast("No matching rows were updated.", "Finished");
    }

    Logger.log("Successfully processed " + changeCounter + " row(s)");
    return { success: true, updatedCount: changeCounter };
  } catch (e) {
    Logger.log("CRITICAL ERROR in processPaidAndClearSelection: " + e.toString() + "\nStack: " + e.stack);
    throw e;
  }
}

/**
 * FEATURE: Clear Selection
 * Automatically unchecks all checked checkboxes in the Select column (H), from row 8.
 */
function runClearSelection() {
  Logger.log("Entering runClearSelection");
  try {
    var ss = getBook_();
    var sheet = ss.getSheetByName(CC_TRACKER_SHEET);
    if (!sheet) {
      getBook_().toast("Error: Tab not found. Check spelling.", "Failed");
      return;
    }

    var startRow = CC_TRACKER_FIRST_DATA_ROW;
    var lastRow = sheet.getLastRow();
    if (lastRow < startRow) {
      getBook_().toast("No data found to clear.", "Finished");
      return;
    }

    var numRows = lastRow - startRow + 1;
    var range = sheet.getRange(startRow, CC_TRACKER_COLS.SELECT, numRows, 1);
    var values = range.getValues();
    var changeCounter = 0;
    var isModified = false;
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === true) {
        values[i][0] = false;
        isModified = true;
        changeCounter++;
      }
    }

    if (isModified) {
      range.setValues(values);
      getBook_().toast("Successfully cleared " + changeCounter + " checked selection(s).", "💳 Selection Cleared");
    } else {
      getBook_().toast("No checked selections found to clear.", "Finished");
    }
  } catch (e) {
    Logger.log("CRITICAL ERROR in runClearSelection: " + e.toString() + "\nStack: " + e.stack);
    getBook_().toast("Error clearing selection: " + e.toString(), "Error");
  }
}

/* ==========================================================================
 * Phone API
 * ========================================================================== */

/**
 * Reads the CC Tracker table (columns A:K) from its first data row down to the
 * last dated row. Used by both the phone list and the phone update, so they
 * always agree on which row is which.
 * @param {Sheet} sheet The CC Tracker sheet.
 * @return {{first: number, values: Array<Array<*>>}|null} Block, or null when empty.
 */
function readCcTrackerBlock_(sheet) {
  var first = CC_TRACKER_FIRST_DATA_ROW;
  var bottom = getLastRowInTargetCol(sheet, CC_TRACKER_START_COL, CC_TRACKER_HEADER_ROW);
  if (bottom < first) return null;
  return {
    first: first,
    values: sheet.getRange(first, 1, bottom - first + 1, CC_TRACKER_COLS.LAST).getValues()
  };
}

/**
 * Identity of one tracker row, the same one the sync uses to avoid duplicates.
 * @param {Array<*>} r One A:K row read from the tracker.
 * @return {string} Fingerprint.
 */
function ccTrackerFingerprint_(r) {
  return ccFingerprint_({ timestamp: r[0], bank: r[1], card: r[2], merchant: r[3],
      type: r[4], amount: r[5], currency: r[6] });
}

/**
 * Lists the CC Tracker rows for the phone app. UI-free and read-only.
 * @return {{missing: boolean, rows: Array<Object>}} Rows keyed by sheet row number.
 */
function listCcTracker_() {
  var context = 'listCcTracker_';
  try {
    var sheet = getBook_().getSheetByName(CC_TRACKER_SHEET);
    if (!sheet) return { missing: true, rows: [] };

    var block = readCcTrackerBlock_(sheet);
    if (!block) return { missing: false, rows: [] };

    var rows = [];
    block.values.forEach(function (r, i) {
      if (r[0] === '' || r[0] === null || r[0] === undefined) return;
      rows.push({
        row: block.first + i,
        fingerprint: ccTrackerFingerprint_(r),
        datetime: ccDatetimeString_(r[0]),
        bank: String(r[1]),
        card: String(r[2]),
        description: String(r[3]),
        type: String(r[4]),
        amount: Number(r[5]) || 0,
        currency: String(r[6]),
        select: isCheckedCell_(r[7]),
        paid: isCheckedCell_(r[8]),
        cancelled: isCheckedCell_(r[9]),
        note: r[10] === null || r[10] === undefined ? '' : String(r[10])
      });
    });
    logInfo(context, 'rows=' + rows.length);
    return { missing: false, rows: rows };
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Applies phone edits to the CC Tracker's Paid, Cancelled and Note columns.
 * A change is applied only when its row still carries the fingerprint the phone
 * read; anything that moved or changed since is counted as stale and left alone.
 * @param {Array<{row: number, fingerprint: string, paid: (boolean|undefined),
 *     cancelled: (boolean|undefined), note: (string|undefined)}>} changes Validated changes.
 * @return {{updated: number, stale: number}} Counts.
 */
function updateCcTrackerRows_(changes) {
  var context = 'updateCcTrackerRows_';
  try {
    return withDocumentLock_(context, function (ss) {
      var sheet = ss.getSheetByName(CC_TRACKER_SHEET);
      if (!sheet) throw new Error('Tab "' + CC_TRACKER_SHEET + '" not found.');

      var block = readCcTrackerBlock_(sheet);
      var live = Object.create(null);
      if (block) {
        block.values.forEach(function (r, i) {
          if (r[0] === '' || r[0] === null || r[0] === undefined) return;
          live[block.first + i] = { fingerprint: ccTrackerFingerprint_(r), values: r };
        });
      }

      var updated = 0;
      var stale = 0;
      changes.forEach(function (change) {
        var hit = live[change.row];
        if (!hit || hit.fingerprint !== change.fingerprint) {
          stale++;
          return;
        }
        var paid = hit.values[8];
        var cancelled = hit.values[9];
        var note = hit.values[10];
        if (typeof change.paid === 'boolean') paid = change.paid;
        if (typeof change.cancelled === 'boolean') cancelled = change.cancelled;
        if (typeof change.note === 'string') note = safeCellText_(change.note.trim());

        sheet.getRange(change.row, CC_TRACKER_COLS.PAID, 1, 3).setValues([[paid, cancelled, note]]);
        updated++;
      });

      logInfo(context, 'updated=' + updated + ' stale=' + stale);
      return { updated: updated, stale: stale };
    });
  } catch (e) {
    logError(context, e);
    throw e;
  }
}
