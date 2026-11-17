/**
 * FinancialSystem.js — the single Monthly Data form (add, update and delete in
 * one pass).
 *
 * Flow
 *   runManageMonthlyData()      opens MonthlyDataEntryDialog.html
 *   getMonthlyEntryPayload()    Master option lists + that month's rows, one trip
 *   applyMonthlyDataChanges()   validates everything, then writes once per sheet
 *
 * The monthly rollover lives in MonthlyGeneration.js, Update Paid Status in
 * PaidStatus.js, and the shared constants and sheet helpers in Common.js.
 */

/** Sheets the form lists, in display order. */
var MANAGED_SHEETS = ['Income', 'Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan'];

/** Sheets new rows may be added to. Income is read/edit only. */
var ADDABLE_SHEETS = ['Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan'];

/**
 * The Type column on Autodeduct Jajan is an owner, not a Master category.
 * Kept as a literal rather than aliasing JAJAN_OWNERS: this runs at load time,
 * and a top-level read of another file's var depends on file order.
 */
var AUTODEDUCT_TYPES = ['Wiva', 'Jane'];

/** Sheet whose rows reduce the jajan budget. */
var AUTODEDUCT_SHEET = 'Autodeduct Jajan';

/** Ledger holding the "Jajan" rows an autodeduction is taken out of. */
var JAJAN_EXPENSE_SHEET = 'Expense';

/** Separator for the row signature that guards against a stale dialog. */
var SIGNATURE_SEPARATOR = '|~|';

/* ==========================================================================
 * Dialog entry point
 * ========================================================================== */

/**
 * Opens the combined Add / Update / Delete monthly data dialog.
 */
function runManageMonthlyData() {
  var context = 'runManageMonthlyData';
  try {
    var template = HtmlService.createTemplateFromFile('MonthlyDataEntryDialog');
    template.defaultMonthLiteral = JSON.stringify(currentMonthKey());

    var html = template.evaluate()
        .setWidth(DIALOG_WIDTH)
        .setHeight(DIALOG_HEIGHT)
        .setTitle('Monthly Data');
    SpreadsheetApp.getUi().showModalDialog(html, 'Monthly Data');
    logInfo(context, 'Monthly data dialog opened on ' + currentMonthKey());
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/* ==========================================================================
 * Loading
 * ========================================================================== */

/**
 * Loads everything the dialog needs for one month in a single round trip: the
 * Master option lists and every existing row dated in that month.
 * @param {string} monthStr Month picked in the dialog ('yyyy-MM').
 * @return {Object} Option lists plus the month's entries.
 */
function getMonthlyEntryPayload(monthStr) {
  var context = 'getMonthlyEntryPayload';
  logInfo(context, 'month=' + monthStr);
  try {
    var targetDateStr = resolveMonthKey_(monthStr);
    var master = readMasterLists_();
    if (!master.found) throw new Error('Master sheet not found.');

    var ss = getBook_();
    var entries = [];
    for (var i = 0; i < MANAGED_SHEETS.length; i++) {
      var sheetName = MANAGED_SHEETS[i];
      var sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        logInfo(context, 'Sheet not found, skipping: ' + sheetName);
        continue;
      }
      collectMonthEntries_(readLedgerSnapshot_(sheet), targetDateStr, entries);
    }

    var payload = {
      month: monthStr,
      targetDate: targetDateStr,
      addableSheets: ADDABLE_SHEETS,
      paymentChannels: master.paymentChannels,
      typeOptions: {
        'Saving': master.savingTypes,
        'Expense': master.expenseTypes,
        'Ibadah': master.ibadahTypes,
        'Autodeduct Jajan': AUTODEDUCT_TYPES
      },
      sortFields: buildEntrySortFields_(),
      entries: entries
    };

    logInfo(context, 'entries=' + entries.length +
        ' channels=' + master.paymentChannels.length +
        ' saving=' + master.savingTypes.length +
        ' expense=' + master.expenseTypes.length +
        ' ibadah=' + master.ibadahTypes.length);

    return payload;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Builds the per-sheet ordering the dialog lists its sections in, taken from the
 * same keys the on-open ledger sort uses so a section reads like its sheet.
 * @return {Object} Map of sheet name -> field names, highest priority first.
 */
function buildEntrySortFields_() {
  var fields = {};
  for (var i = 0; i < MANAGED_SHEETS.length; i++) {
    fields[MANAGED_SHEETS[i]] = getLedgerSortFields(MANAGED_SHEETS[i]);
  }
  return fields;
}

/**
 * Appends one sheet's rows for the target month onto the shared accumulator.
 * @param {Object} snapshot Snapshot from readLedgerSnapshot_.
 * @param {string} targetDateStr Month key ('yyyy-MM-01').
 * @param {Array<Object>} entries Accumulator, mutated in place.
 */
function collectMonthEntries_(snapshot, targetDateStr, entries) {
  var C = LEDGER_COLUMNS;
  var values = snapshot.values;
  var isIncome = (snapshot.name === 'Income');

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (formatDateToYMD(row[C.DATE]) !== targetDateStr) continue;

    var amount = typeof row[C.AMOUNT] === 'number' ? row[C.AMOUNT] : 0;
    entries.push({
      sheet: snapshot.name,
      rowNum: r + 1,
      isIncome: isIncome,
      signature: rowSignature_(row),
      list: orPlaceholder_(row[C.LIST]),
      type: orPlaceholder_(row[C.TYPE]),
      amount: amount,
      amountFormatted: formatCurrency(amount),
      channel: isIncome ? '' : (row[C.CHANNEL] || ''),
      isCicilan: !isIncome && isCheckedCell_(row[C.IS_CICILAN]),
      remainingMonth: isIncome ? '' : (row[C.REMAINING] === null ||
          row[C.REMAINING] === undefined ? '' : String(row[C.REMAINING])),
      isPaid: !isIncome && isCheckedCell_(row[C.PAID])
    });
  }
}

/**
 * Fingerprints the columns the dialog never edits, so a row that moved or
 * changed underneath an open dialog is skipped instead of silently overwritten.
 * @param {Array<*>} row Ledger row.
 * @return {string} Signature.
 */
function rowSignature_(row) {
  var C = LEDGER_COLUMNS;
  return formatDateToYMD(row[C.DATE]) + SIGNATURE_SEPARATOR +
      String(row[C.LIST]) + SIGNATURE_SEPARATOR + String(row[C.TYPE]);
}

/**
 * Validates a 'yyyy-MM' month string from the dialog.
 * @param {string} monthStr Month string.
 * @return {string} Month key ('yyyy-MM-01').
 */
function resolveMonthKey_(monthStr) {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(String(monthStr))) {
    throw new Error('Invalid month: ' + monthStr + ' (expected yyyy-MM).');
  }
  var key = formatDateToYMD(monthStr + '-01');
  if (!key) throw new Error('Invalid month: ' + monthStr);
  return key;
}

/* ==========================================================================
 * Applying changes
 * ========================================================================== */

/**
 * Public entry point for the Monthly Data form and the rollover's target-month
 * edits. Holds the spreadsheet lock for the whole write.
 * @param {Object} payload {month, updates, deletions, additions}.
 * @return {Object} Result counts, or {success:false, error} on failure.
 */
function applyMonthlyDataChanges(payload) {
  try {
    return withDocumentLock_('applyMonthlyDataChanges', function () {
      return applyMonthlyDataChangesUnlocked_(payload);
    });
  } catch (e) {
    logError('applyMonthlyDataChanges', e);
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Applies the dialog's additions, updates and deletions in one call.
 *
 * Everything is validated before a single cell is written, so a bad row aborts
 * the whole submission rather than leaving the ledgers half-changed. Each sheet
 * is then read once and written once: updates in place, additions appended,
 * deletions removed bottom-up so earlier row numbers stay valid.
 *
 * Autodeductions feed back into the jajan budget: any change to the
 * Autodeduct Jajan sheet moves that person's Expense "Jajan" row for the month
 * by the same figure, exactly as the rollover does when it generates them.
 *
 * @param {Object} payload {month, updates, deletions, additions}.
 * @return {Object} Result counts, or {success:false, error} on failure.
 */
function applyMonthlyDataChangesUnlocked_(payload) {
  var context = 'applyMonthlyDataChanges';
  try {
    var plan = validateChangePayload_(payload);
    logInfo(context, 'month=' + plan.month +
        ' updates=' + plan.totals.updates +
        ' deletions=' + plan.totals.deletions +
        ' additions=' + plan.totals.additions);

    var ss = getBook_();
    var result = {
      success: true, updated: 0, deleted: 0, added: 0,
      skipped: [], jajanAdjusted: []
    };

    // Only what actually lands on the sheet counts towards the jajan delta, so
    // it is accumulated inside the write rather than read off the payload.
    var jajanDelta = newJajanDelta_();

    for (var sheetName in plan.bySheet) {
      if (!Object.prototype.hasOwnProperty.call(plan.bySheet, sheetName)) continue;

      var sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        result.skipped.push(sheetName + ': sheet not found');
        logInfo(context, 'Sheet not found, skipping: ' + sheetName);
        continue;
      }

      // Counts are coerced: a single NaN would make the whole result
      // unserialisable and reach the dialog as a bare "unknown error".
      var applied = applySheetChanges_(sheet, plan.bySheet[sheetName], result.skipped,
          sheetName === AUTODEDUCT_SHEET ? jajanDelta : null);
      result.updated += Number(applied.updated) || 0;
      result.deleted += Number(applied.deleted) || 0;
      result.added += Number(applied.added) || 0;
    }

    // Runs last, and re-reads Expense, so it lands on top of any Jajan row the
    // same submission just edited rather than racing it.
    applyJajanAdjustment_(ss, plan.month, jajanDelta, result);

    logInfo(context, 'Completed: updated=' + result.updated +
        ' deleted=' + result.deleted + ' added=' + result.added +
        ' skipped=' + result.skipped.length +
        ' jajanAdjusted=' + result.jajanAdjusted.length);

    return result;
  } catch (e) {
    logError(context, e);
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Normalises and validates the whole submission, grouped by sheet.
 * @param {Object} payload Raw payload from the dialog.
 * @return {Object} {month, bySheet, totals}.
 */
function validateChangePayload_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing change payload.');
  }

  var targetDateStr = resolveMonthKey_(payload.month);
  var updates = asArray_(payload.updates);
  var deletions = asArray_(payload.deletions);
  var additions = asArray_(payload.additions);

  if (!updates.length && !deletions.length && !additions.length) {
    throw new Error('Nothing to save.');
  }

  var bySheet = {};
  var i;

  for (i = 0; i < updates.length; i++) {
    var update = updates[i];
    var updateSheet = requireManagedSheet_(update.sheet, 'Update');
    var updateLabel = describeRow_(update);
    bucketFor_(bySheet, updateSheet).updates.push({
      rowNum: requireRowNumber_(update.rowNum, 'Update'),
      signature: String(update.signature || ''),
      label: updateLabel,
      fields: normaliseLedgerFields_(update, updateLabel, updateSheet === 'Income')
    });
  }

  for (i = 0; i < deletions.length; i++) {
    var deletion = deletions[i];
    var deleteSheet = requireManagedSheet_(deletion.sheet, 'Delete');
    bucketFor_(bySheet, deleteSheet).deletions.push({
      rowNum: requireRowNumber_(deletion.rowNum, 'Delete'),
      signature: String(deletion.signature || ''),
      label: describeRow_(deletion)
    });
  }

  for (i = 0; i < additions.length; i++) {
    var addition = additions[i];
    var sheetName = requireAddableSheet_(addition.sheet);
    var label = describeRow_(addition);

    var list = trimText_(addition.list);
    if (list === '') throw new Error(label + ': description cannot be empty.');
    var type = trimText_(addition.type);
    if (type === '') throw new Error(label + ': please choose a type/category.');

    var fields = normaliseLedgerFields_(addition, label, false);
    bucketFor_(bySheet, sheetName).additions.push([
      targetDateStr, safeCellText_(list), safeCellText_(type), fields.amount,
      fields.channel, fields.isCicilan, fields.remainingMonth, fields.isPaid
    ]);
  }

  return {
    month: targetDateStr,
    bySheet: bySheet,
    totals: {
      updates: updates.length,
      deletions: deletions.length,
      additions: additions.length
    }
  };
}

/**
 * Validates the editable ledger fields shared by additions and updates.
 * @param {Object} raw Row payload from the dialog.
 * @param {string} label Row description used in error messages.
 * @param {boolean} amountOnly True for Income rows, which carry no channel or
 *     installment columns.
 * @return {Object} Clean field values.
 */
function normaliseLedgerFields_(raw, label, amountOnly) {
  var amount = Number(raw.amount);
  if (!isFinite(amount) || amount <= 0) {
    throw new Error(label + ': amount must be a number greater than zero (received: ' +
        raw.amount + ').');
  }
  if (amountOnly) {
    return {
      amountOnly: true, amount: amount, channel: '',
      isCicilan: false, remainingMonth: '', isPaid: false
    };
  }

  var isCicilan = (raw.isCicilan === true || raw.isCicilan === 'true');
  var remainingMonth = '';
  if (isCicilan) {
    remainingMonth = parseInt(raw.remainingMonth, 10);
    if (isNaN(remainingMonth) || remainingMonth <= 0) {
      throw new Error(label + ': payment remaining must be a whole number above zero (received: ' +
          raw.remainingMonth + ').');
    }
  }

  return {
    amountOnly: false,
    amount: amount,
    channel: safeCellText_(trimText_(raw.channel)),
    isCicilan: isCicilan,
    remainingMonth: remainingMonth,
    isPaid: (raw.isPaid === true || raw.isPaid === 'true')
  };
}

/**
 * Rewrites, appends and removes one sheet's rows.
 * @param {Sheet} sheet Target sheet.
 * @param {Object} bucket {updates, deletions, additions} for this sheet.
 * @param {Array<string>} skipped Accumulator for rows that no longer match.
 * @param {Object} jajanDelta Per-owner accumulator, or null when this sheet
 *     does not feed the jajan budget. Only applied rows are counted.
 * @return {{updated: number, deleted: number, added: number}} Counts.
 */
function applySheetChanges_(sheet, bucket, skipped, jajanDelta) {
  var C = LEDGER_COLUMNS;
  var snapshot = readLedgerSnapshot_(sheet);
  var counts = { updated: 0, deleted: 0, added: 0 };

  // --- Updates: mutate the snapshot, then write the touched span in one call.
  var firstDirty = -1;
  var lastDirty = -1;

  for (var u = 0; u < bucket.updates.length; u++) {
    var update = bucket.updates[u];
    var rowIdx = update.rowNum - 1;
    var row = snapshot.values[rowIdx];

    if (!row || rowSignature_(row) !== update.signature) {
      skipped.push(update.label + ': row changed since it was loaded');
      continue;
    }

    // Signed against the value being replaced: raising an autodeduction takes
    // more out of the jajan pool, lowering it hands the difference back.
    addJajanDelta_(jajanDelta, row[C.TYPE],
        update.fields.amount - (Number(row[C.AMOUNT]) || 0));

    row[C.AMOUNT] = update.fields.amount;
    if (!update.fields.amountOnly) {
      row[C.CHANNEL] = update.fields.channel;
      row[C.IS_CICILAN] = update.fields.isCicilan;
      row[C.REMAINING] = update.fields.remainingMonth;
      row[C.PAID] = update.fields.isPaid;
    }

    counts.updated++;
    if (firstDirty === -1 || rowIdx < firstDirty) firstDirty = rowIdx;
    if (rowIdx > lastDirty) lastDirty = rowIdx;
  }

  if (firstDirty !== -1) {
    sheet.getRange(firstDirty + 1, 1, lastDirty - firstDirty + 1, snapshot.totalColumns)
        .setValues(snapshot.values.slice(firstDirty, lastDirty + 1));
  }

  // --- Additions: one block right after the ledger, not after getLastRow(),
  // which counts the template's unticked checkboxes down to row 1000.
  if (bucket.additions.length) {
    var startRow = firstFreeLedgerRow_(snapshot);
    ensureRowCapacity_(sheet, startRow + bucket.additions.length - 1);

    var block = bucket.additions.map(function (addition) {
      addJajanDelta_(jajanDelta, addition[C.TYPE], Number(addition[C.AMOUNT]) || 0);
      return padRow_(addition.slice(), snapshot.totalColumns);
    });
    sheet.getRange(startRow, 1, block.length, snapshot.totalColumns).setValues(block);
    counts.added = block.length;
  }

  // --- Deletions last, bottom-up, so the row numbers above stay valid.
  var doomed = [];
  for (var d = 0; d < bucket.deletions.length; d++) {
    var deletion = bucket.deletions[d];
    var doomedRow = snapshot.values[deletion.rowNum - 1];
    if (!doomedRow || rowSignature_(doomedRow) !== deletion.signature) {
      skipped.push(deletion.label + ': row changed since it was loaded');
      continue;
    }
    // A removed autodeduction stops taking anything out of the pool.
    addJajanDelta_(jajanDelta, doomedRow[C.TYPE], -(Number(doomedRow[C.AMOUNT]) || 0));
    doomed.push(deletion.rowNum);
  }
  counts.deleted = deleteRowsDescending_(sheet, doomed) || 0;

  return counts;
}

/* ==========================================================================
 * Jajan budget feedback
 *
 * The rollover derives each person's Expense "Jajan" row as
 *   gross jajan share - their autodeductions
 * (see calculateJajanAllocation_ in MonthlyGeneration.js). Editing the
 * Autodeduct Jajan sheet by hand has to keep that relationship true, so every
 * applied change moves the matching Jajan row by the same figure: add a
 * 220.000 autodeduction for Wiva and Wiva's Jajan for that month drops 220.000.
 * ========================================================================== */

/**
 * @return {!Object} Zeroed per-owner accumulator.
 */
function newJajanDelta_() {
  var delta = {};
  for (var i = 0; i < JAJAN_OWNERS.length; i++) delta[JAJAN_OWNERS[i]] = 0;
  return delta;
}

/**
 * Records how much more (or less) an owner is autodeducting.
 * @param {Object} delta Accumulator from newJajanDelta_, or null to ignore.
 * @param {*} ownerCell Type column of the Autodeduct Jajan row.
 * @param {number} amount Signed change in autodeducted IDR.
 */
function addJajanDelta_(delta, ownerCell, amount) {
  if (!delta || !isFinite(amount) || amount === 0) return;
  var owner = normaliseJajanOwner_(ownerCell);
  if (!owner) return;
  delta[owner] += amount;
}

/**
 * Moves each owner's Expense "Jajan" row for the month by their delta.
 *
 * Expense is re-read here rather than reused from the write loop, so an edit
 * this same submission made to a Jajan row is the figure being adjusted.
 * A person with no Jajan row in the month has nothing to deduct from; that is
 * reported rather than invented, because a row created here would be a negative
 * budget with no gross share behind it.
 *
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {string} targetDateStr Month key ('yyyy-MM-01').
 * @param {Object} delta Accumulator from newJajanDelta_.
 * @param {Object} result Result object, mutated with notes.
 */
function applyJajanAdjustment_(ss, targetDateStr, delta, result) {
  var context = 'applyJajanAdjustment_';

  var pending = {};
  var owedCount = 0;
  for (var i = 0; i < JAJAN_OWNERS.length; i++) {
    var owner = JAJAN_OWNERS[i];
    if (delta[owner]) {
      pending[owner] = delta[owner];
      owedCount++;
    }
  }
  if (!owedCount) return;

  var sheet = ss.getSheetByName(JAJAN_EXPENSE_SHEET);
  if (!sheet) {
    result.skipped.push(JAJAN_EXPENSE_SHEET + ': sheet not found, jajan not adjusted');
    logInfo(context, 'Expense sheet not found; jajan left unadjusted.');
    return;
  }

  var C = LEDGER_COLUMNS;
  var values = readLedgerSnapshot_(sheet).values;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (formatDateToYMD(row[C.DATE]) !== targetDateStr) continue;
    if (!isJajanRow_(row[C.TYPE])) continue;

    // On Expense the Jajan row carries the person in List, not Type.
    var rowOwner = normaliseJajanOwner_(row[C.LIST]);
    if (!rowOwner || !pending[rowOwner]) continue;

    var before = Number(row[C.AMOUNT]) || 0;
    var after = Math.max(0, Math.round(before - pending[rowOwner]));
    sheet.getRange(r + 1, C.AMOUNT + 1).setValue(after);

    result.jajanAdjusted.push(rowOwner + ': ' + formatCurrency(before) +
        ' → ' + formatCurrency(after));
    logInfo(context, rowOwner + ' jajan ' + before + ' -> ' + after +
        ' (delta ' + pending[rowOwner] + ')');

    // One Jajan row per person per month; stop after the first.
    delete pending[rowOwner];
  }

  for (var leftover in pending) {
    if (!Object.prototype.hasOwnProperty.call(pending, leftover)) continue;
    result.skipped.push('No Expense / Jajan row for ' + leftover + ' in this month, ' +
        'so the autodeduct change was not taken off any budget');
    logInfo(context, 'No Jajan row for ' + leftover + ' in ' + targetDateStr);
  }
}

/* ---------------- payload helpers ---------------- */

/**
 * @param {*} value Possibly missing array.
 * @return {Array<*>} The array, or [].
 */
function asArray_(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {*} value Any value.
 * @return {string} Trimmed string ('' when null/undefined).
 */
function trimText_(value) {
  return (value === null || value === undefined) ? '' : String(value).trim();
}

/**
 * @param {Object} bySheet Accumulator keyed by sheet name.
 * @param {string} sheetName Sheet name.
 * @return {Object} That sheet's bucket, created on first use.
 */
function bucketFor_(bySheet, sheetName) {
  if (!bySheet[sheetName]) {
    bySheet[sheetName] = { updates: [], deletions: [], additions: [] };
  }
  return bySheet[sheetName];
}

/**
 * @param {*} sheetName Sheet name from the dialog.
 * @param {string} action Verb used in the error message.
 * @return {string} The validated sheet name.
 */
function requireManagedSheet_(sheetName, action) {
  var name = trimText_(sheetName);
  if (MANAGED_SHEETS.indexOf(name) === -1) {
    throw new Error(action + ' rejected: "' + name + '" is not a managed sheet.');
  }
  return name;
}

/**
 * @param {*} sheetName Sheet name from the dialog.
 * @return {string} The validated sheet name.
 */
function requireAddableSheet_(sheetName) {
  var name = trimText_(sheetName);
  if (ADDABLE_SHEETS.indexOf(name) === -1) {
    throw new Error('New rows cannot be added to "' + name + '".');
  }
  return name;
}

/**
 * @param {*} rowNum Row number from the dialog.
 * @param {string} action Verb used in the error message.
 * @return {number} A row number below the header.
 */
function requireRowNumber_(rowNum, action) {
  var parsed = parseInt(rowNum, 10);
  if (isNaN(parsed) || parsed < 2) {
    throw new Error(action + ' rejected: invalid row number ' + rowNum + '.');
  }
  return parsed;
}

/**
 * Describes a row for an error message without quoting any amount.
 * @param {Object} raw Row payload.
 * @return {string} e.g. 'Expense / Listrik'.
 */
function describeRow_(raw) {
  var sheetName = trimText_(raw && raw.sheet) || 'Row';
  var list = trimText_(raw && raw.list);
  return list === '' ? sheetName : sheetName + ' / ' + list;
}
