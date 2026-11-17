/**
 * PaidStatus.js — "Update Paid Status": ticks "Sudah Bayar?" on the ledgers from
 * the Dashboard checklists.
 *
 * Two Dashboard checklists drive it, combined with OR:
 *   - Per payment channel: every unpaid row of that channel in the Dashboard
 *     month is marked paid.
 *   - Per row: only the ledger row with the same List + Type + Payment Channel
 *     in that month is marked paid.
 * A row picked by both is simply marked once. Every ticked box on the Dashboard
 * is cleared afterwards, so each tick is a one-time instruction.
 *
 * `updatePaidStatus()` is UI-free and safe to attach to a time-driven trigger.
 * The menu path opens AutomationSummaryDialog, which calls the same function
 * and shows what changed, grouped per payment channel.
 */

/* ==========================================================================
 * SETTINGS — edit here when the Dashboard layout moves
 *
 * Rows are sheet row numbers and columns are sheet column letters, exactly as
 * they appear in the spreadsheet. Nothing else in this file needs to change.
 * ========================================================================== */
var PAID_STATUS_CONFIG = {
  // Sheet that holds the month and both checklists.
  dashboardSheet: 'Dashboard',

  // Cell holding the month to update. Any date inside the month works.
  monthCell: 'B1',

  // Checklist 1 — per payment channel: marks every row of the ticked channel.
  channelChecklist: {
    firstRow: 21,
    lastRow: 34,
    nameColumn: 'A',
    checkboxColumn: 'E'
  },

  // Checklist 2 — per row: marks only the ledger row that matches.
  rowChecklist: {
    firstRow: 8,
    lastRow: 68,
    listColumn: 'U',
    typeColumn: 'V',
    channelColumn: 'X',
    checkboxColumn: 'AB'
  },

  // Ledger sheets to update. Each uses the standard columns A-H.
  targetSheets: ['Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan']
};

/** How long a run waits for another run to finish before giving up (ms). */
var PAID_STATUS_LOCK_TIMEOUT_MS = 30000;

/* ==========================================================================
 * Entry points
 * ========================================================================== */

/**
 * Menu entry point: opens the dialog, which runs the update and shows the result.
 */
function runUpdatePaidStatus() {
  var context = 'runUpdatePaidStatus';
  try {
    var html = HtmlService.createHtmlOutputFromFile('AutomationSummaryDialog')
        .setWidth(DIALOG_WIDTH)
        .setHeight(DIALOG_HEIGHT)
        .setTitle('Update Paid Status');
    SpreadsheetApp.getUi().showModalDialog(html, 'Update Paid Status');
    logInfo(context, 'Opened AutomationSummaryDialog.');
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Marks the ticked channels and rows as paid for the Dashboard month, then
 * clears every ticked Dashboard checkbox.
 *
 * Trigger-safe: no UI, holds the document lock, and returns quietly when
 * nothing is ticked. Real problems (missing Dashboard, invalid month, bad
 * settings) are logged and thrown so a trigger run reports them.
 *
 * @return {{monthStr: string, nothingSelected: boolean, updated: number,
 *           channels: Array<Object>, unmatchedRows: Array<Object>,
 *           missingSheets: Array<string>}} What changed.
 */
function updatePaidStatus() {
  var context = 'updatePaidStatus';
  var lock = getLock_();
  if (!lock.tryLock(PAID_STATUS_LOCK_TIMEOUT_MS)) {
    throw new Error('Another paid-status update is already running. Try again in a moment.');
  }

  try {
    var config = PAID_STATUS_CONFIG;
    var ss = getBook_();
    var dashboard = ss.getSheetByName(config.dashboardSheet);
    if (!dashboard) throw new Error('Sheet "' + config.dashboardSheet + '" not found.');

    var monthStr = formatDateToYMD(dashboard.getRange(config.monthCell).getValue());
    if (!monthStr) {
      throw new Error('No valid month in ' + config.dashboardSheet + '!' + config.monthCell + '.');
    }

    var channelTicks = readTickedRows_(dashboard, config.channelChecklist,
        { name: 'nameColumn' }, 'channelChecklist');
    var rowTicks = readTickedRows_(dashboard, config.rowChecklist,
        { list: 'listColumn', type: 'typeColumn', channel: 'channelColumn' }, 'rowChecklist');
    logInfo(context, 'Month ' + monthStr + ' | ticked channels: ' + channelTicks.length +
        ' | ticked rows: ' + rowTicks.length);

    var report = {
      monthStr: monthStr,
      nothingSelected: false,
      updated: 0,
      channels: [],
      unmatchedRows: [],
      missingSheets: []
    };

    if (!channelTicks.length && !rowTicks.length) {
      report.nothingSelected = true;
      logInfo(context, 'Nothing ticked on the Dashboard; nothing to do.');
      return report;
    }

    var selection = buildPaidSelection_(channelTicks, rowTicks);
    var groups = Object.create(null);

    config.targetSheets.forEach(function (sheetName) {
      var sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        report.missingSheets.push(sheetName);
        logInfo(context, 'Target sheet not found, skipped: ' + sheetName);
        return;
      }
      report.updated += markSheetPaid_(sheet, monthStr, selection, groups);
    });

    report.channels = finaliseChannelGroups_(groups, selection);
    report.unmatchedRows = selection.events.filter(function (event) {
      return !event.found;
    }).map(function (event) {
      return { list: event.list, type: event.type, channel: event.channel };
    });

    clearTicks_(dashboard, channelTicks.concat(rowTicks));
    logInfo(context, 'Marked ' + report.updated + ' row(s) paid; ' +
        report.unmatchedRows.length + ' ticked row(s) had no ledger match.');
    return report;
  } catch (e) {
    logError(context, e);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/* ==========================================================================
 * Dashboard
 * ========================================================================== */

/**
 * Reads one checklist block in a single Range call and returns its ticked rows.
 *
 * @param {Sheet} sheet Dashboard sheet.
 * @param {Object} checklist Checklist settings (firstRow, lastRow, *Column).
 * @param {!Object<string, string>} fields Output field -> settings key holding its column.
 * @param {string} label Settings name, for error messages.
 * @return {Array<Object>} One entry per ticked row: `cell` (A1 of the checkbox)
 *     plus each requested field as trimmed text.
 */
function readTickedRows_(sheet, checklist, fields, label) {
  var firstRow = Number(checklist.firstRow);
  var lastRow = Number(checklist.lastRow);
  if (!(firstRow >= 1) || !(lastRow >= firstRow) || firstRow % 1 || lastRow % 1) {
    throw new Error('Settings ' + label + ': firstRow/lastRow must be row numbers with lastRow >= firstRow.');
  }

  var checkboxLetter = String(checklist.checkboxColumn).trim().toUpperCase();
  var columns = { checkbox: columnLetterToNumber_(checkboxLetter, label + '.checkboxColumn') };
  Object.keys(fields).forEach(function (field) {
    columns[field] = columnLetterToNumber_(checklist[fields[field]], label + '.' + fields[field]);
  });

  var numbers = Object.keys(columns).map(function (key) { return columns[key]; });
  var left = Math.min.apply(null, numbers);
  var right = Math.max.apply(null, numbers);
  var values = sheet.getRange(firstRow, left, lastRow - firstRow + 1, right - left + 1).getValues();

  var ticked = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!isCheckedCell_(row[columns.checkbox - left])) continue;
    var item = { cell: checkboxLetter + (firstRow + r) };
    Object.keys(fields).forEach(function (field) {
      item[field] = trimText_(row[columns[field] - left]);
    });
    ticked.push(item);
  }
  return ticked;
}

/**
 * Unticks exactly the given checkbox cells — nothing else on the Dashboard is
 * written, so formulas and formatting around the checklists stay untouched.
 * @param {Sheet} sheet Dashboard sheet.
 * @param {Array<{cell: string}>} ticks Ticked entries from readTickedRows_.
 */
function clearTicks_(sheet, ticks) {
  if (!ticks.length) return;
  sheet.getRangeList(ticks.map(function (tick) { return tick.cell; })).setValue(false);
}

/**
 * Turns the ticked Dashboard rows into lookups for the ledger scan.
 * @param {Array<{name: string}>} channelTicks Ticked channel rows.
 * @param {Array<{list: string, type: string, channel: string}>} rowTicks Ticked event rows.
 * @return {{channels: !Object<string, string>, eventsByKey: !Object<string, Object>,
 *           events: Array<Object>}} Lowercased channel -> display name, and the
 *     de-duplicated events with a `found` flag.
 */
function buildPaidSelection_(channelTicks, rowTicks) {
  var channels = Object.create(null);
  channelTicks.forEach(function (tick) {
    if (tick.name) channels[tick.name.toLowerCase()] = tick.name;
  });

  var eventsByKey = Object.create(null);
  var events = [];
  rowTicks.forEach(function (tick) {
    if (!tick.list) return;
    var key = paidEventKey_(tick.list, tick.type, tick.channel);
    if (eventsByKey[key]) return;
    var event = { list: tick.list, type: tick.type, channel: tick.channel, found: false };
    eventsByKey[key] = event;
    events.push(event);
  });

  return { channels: channels, eventsByKey: eventsByKey, events: events };
}

/**
 * Case- and space-insensitive identity of a row: List + Type + Payment Channel.
 * @return {string} Lookup key.
 */
function paidEventKey_(list, type, channel) {
  return [list, type, channel].map(function (value) {
    return trimText_(value).toLowerCase();
  }).join(KEY_SEPARATOR);
}

/* ==========================================================================
 * Ledgers
 * ========================================================================== */

/**
 * Marks the selected, still-unpaid rows of one ledger for the month.
 *
 * Only the changed "Sudah Bayar?" cells are written (one RangeList call), so no
 * other cell — and no formula — in the ledger is ever overwritten.
 *
 * @param {Sheet} sheet Ledger sheet.
 * @param {string} monthStr Target month ('yyyy-MM-01').
 * @param {Object} selection From buildPaidSelection_; events get `found` set.
 * @param {!Object} groups Report accumulator keyed by lowercased channel.
 * @return {number} Rows marked paid.
 */
function markSheetPaid_(sheet, monthStr, selection, groups) {
  var sheetName = sheet.getName();
  var values = readLedgerSnapshot_(sheet).values;
  var paidLetter = columnNumberToLetter_(LEDGER_COLUMNS.PAID + 1);
  var cells = [];

  // values[0] is the header, so values[r] is sheet row r + 1.
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (formatDateToYMD(row[LEDGER_COLUMNS.DATE]) !== monthStr) continue;

    var channel = trimText_(row[LEDGER_COLUMNS.CHANNEL]);
    var event = selection.eventsByKey[
        paidEventKey_(row[LEDGER_COLUMNS.LIST], row[LEDGER_COLUMNS.TYPE], channel)];
    var byChannel = !!selection.channels[channel.toLowerCase()];
    if (event) event.found = true;
    if ((!byChannel && !event) || isCheckedCell_(row[LEDGER_COLUMNS.PAID])) continue;

    cells.push(paidLetter + (r + 1));
    var amount = typeof row[LEDGER_COLUMNS.AMOUNT] === 'number' ? row[LEDGER_COLUMNS.AMOUNT] : 0;
    channelGroup_(groups, channel).items.push({
      sheet: sheetName,
      list: orPlaceholder_(trimText_(row[LEDGER_COLUMNS.LIST])),
      type: orPlaceholder_(trimText_(row[LEDGER_COLUMNS.TYPE])),
      amount: amount,
      amountFormatted: formatCurrency(amount),
      via: byChannel && event ? 'Channel + Row' : (byChannel ? 'Channel' : 'Row')
    });
  }

  if (cells.length) sheet.getRangeList(cells).setValue(true);
  logInfo('markSheetPaid_', sheetName + ': marked ' + cells.length + ' row(s) paid.');
  return cells.length;
}

/* ==========================================================================
 * Report
 * ========================================================================== */

/**
 * @param {!Object} groups Accumulator keyed by lowercased channel.
 * @param {string} channel Channel as written in the ledger.
 * @return {{name: string, items: Array<Object>}} That channel's group.
 */
function channelGroup_(groups, channel) {
  var key = channel.toLowerCase();
  if (!groups[key]) groups[key] = { name: channel || BLANK_PLACEHOLDER, items: [] };
  return groups[key];
}

/**
 * Adds an (empty) group for every ticked channel that had nothing to mark, then
 * sorts groups A-Z and each group's rows by amount, largest first.
 * @return {Array<{name: string, wholeChannel: boolean, items: Array<Object>}>} Groups.
 */
function finaliseChannelGroups_(groups, selection) {
  Object.keys(selection.channels).forEach(function (key) {
    if (!groups[key]) groups[key] = { name: selection.channels[key], items: [] };
  });

  return Object.keys(groups).sort().map(function (key) {
    var group = groups[key];
    group.wholeChannel = !!selection.channels[key];
    group.items.sort(function (a, b) { return b.amount - a.amount; });
    return group;
  });
}

/* ==========================================================================
 * Column letters
 * ========================================================================== */

/**
 * @param {string} letters Column letters such as "AB".
 * @param {string} label Settings name, for the error message.
 * @return {number} 1-based column number.
 */
function columnLetterToNumber_(letters, label) {
  var text = trimText_(letters).toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(text)) {
    throw new Error('Settings ' + label + ': "' + letters + '" is not a column letter.');
  }
  var number = 0;
  for (var i = 0; i < text.length; i++) number = number * 26 + (text.charCodeAt(i) - 64);
  return number;
}

/**
 * @param {number} number 1-based column number.
 * @return {string} Column letters such as "H".
 */
function columnNumberToLetter_(number) {
  var letters = '';
  while (number > 0) {
    var remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return letters;
}
