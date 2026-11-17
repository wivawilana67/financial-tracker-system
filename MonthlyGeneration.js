/**
 * MonthlyGeneration.js — the "Generate Monthly Data" rollover.
 *
 * Flow
 *   runGenerateMonthlyData()        opens MonthlyDataDialog.html
 *   getMonthlyInitializationPayload() feeds that dialog with Master lists and
 *                                   the M-1 rollover candidates
 *   showLoadingAndSummary()         swaps in LoadingSummaryDialog.html
 *   executeMonthlyGeneration()      writes the ledgers and returns the audit
 *
 * Strategy: upsert. A candidate row that already exists for the target month is
 * updated in place; anything else is appended.
 *
 * The rollover never removes a row. A row you added yourself is only ever
 * touched when a ticked candidate carries the same List + Type + Note/Channel,
 * and then only its amount and installment columns are rewritten — the row
 * itself, and every row no candidate matches, is left where it is. See
 * writeMergedRows_ for the one place that could ever clear a cell.
 *
 * Re-running the same month is idempotent, including for installments: the
 * candidate scan only ever looks at rows dated *before* the target month, so a
 * row this rollover already wrote can never be read back and decremented twice.
 *
 * Shared constants and helpers live in Common.js.
 */

/** Sheets touched by the rollover, in report order. */
var GENERATION_SHEETS = ['Income', 'Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan'];

/** Maps a rollover sheet to the formData field holding its selected uids. */
var ROLLOVER_SELECTION_FIELDS = {
  'Saving': 'selectedSaving',
  'Expense': 'selectedExpense',
  'Ibadah': 'selectedIbadah'
};

/** Fallback jajan payment channels when the dialog sends nothing. */
var DEFAULT_WIVA_JAJAN_CHANNEL = 'BCA Expressi Rio';
var DEFAULT_JANE_JAJAN_CHANNEL = 'BCA Debit Jane';

/** Income category assumed to fund the jajan pool when none is selected. */
var DEFAULT_JAJAN_INCOME_CATEGORY = 'Salary';

/** Income row owners, matching the two columns the rollover dialog renders. */
var INCOME_PERSONS = ['Wiva', 'Jane'];

/**
 * Ledger sheets the dialog's "Already in target month" tab lists and edits.
 * Income is absent on purpose: its target-month figures are the prefilled
 * boxes on the rollover tab, and editing the same numbers in two places would
 * leave the form arguing with itself.
 */
var TARGET_EDIT_SHEETS = ['Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan'];

/* ==========================================================================
 * Dialog entry points
 * ========================================================================== */

/**
 * Opens the rollover configuration dialog.
 */
function runGenerateMonthlyData() {
  var context = 'runGenerateMonthlyData';
  try {
    var template = HtmlService.createTemplateFromFile('MonthlyDataDialog');
    template.defaultMonthLiteral = JSON.stringify(currentMonthKey());

    var html = template.evaluate()
        .setWidth(DIALOG_WIDTH)
        .setHeight(DIALOG_HEIGHT)
        .setTitle('Financial System Rollover');
    SpreadsheetApp.getUi().showModalDialog(html, 'Generate Monthly Data');
    logInfo(context, 'Configuration dialog opened on ' + currentMonthKey());
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Replaces the configuration dialog with the progress/summary dialog, carrying
 * the submitted configuration across as an escaped script literal.
 * @param {Object} formData Configuration inputs from the generation form.
 */
function showLoadingAndSummary(formData) {
  var context = 'showLoadingAndSummary';
  try {
    if (!formData || typeof formData !== 'object') {
      throw new Error('Missing generation configuration.');
    }
    logInfo(context, describeSelections_(formData));

    var template = HtmlService.createTemplateFromFile('LoadingSummaryDialog');
    template.formDataLiteral = toScriptLiteral_(formData);

    var html = template.evaluate()
        .setWidth(DIALOG_WIDTH)
        .setHeight(DIALOG_HEIGHT)
        .setTitle('Financial System Rollover');

    SpreadsheetApp.getUi().showModalDialog(html, 'Generate Monthly Data');
    logInfo(context, 'Progress dialog opened');
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/* ==========================================================================
 * Dialog data loading
 * ========================================================================== */

/**
 * Loads everything the configuration dialog needs in one server round trip.
 * @param {number} targetMonthIdx 0-based index of the month being generated.
 * @param {number} targetYear Full year of the month being generated.
 * @return {Object} Master lists, the resolved period, and rollover candidates.
 */
function getMonthlyInitializationPayload(targetMonthIdx, targetYear) {
  var context = 'getMonthlyInitializationPayload';
  logInfo(context, 'monthIndex=' + targetMonthIdx + ' year=' + targetYear);
  try {
    var period = resolvePeriod_(targetMonthIdx, targetYear);
    var master = readMasterLists_();
    var ss = getBook_();

    var targetRows = loadTargetMonthRows_(ss, period);
    var pending = {};
    var alreadyInMonth = 0;
    ['Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan'].forEach(function (sheetName) {
      var split = splitCandidatesByTarget_(
          sheetName, loadCandidates_(ss, sheetName, period), targetRows, period);
      pending[sheetName] = split.pending;
      alreadyInMonth += split.claimed;
    });

    var payload = {
      categories: master.incomeCategories,
      paymentChannels: master.paymentChannels,
      sourceMonth: period.sourceDateStr,
      targetMonth: period.targetDateStr,
      savingCandidates: pending['Saving'],
      expenseCandidates: pending['Expense'],
      ibadahCandidates: pending['Ibadah'],
      autodeductCandidates: pending['Autodeduct Jajan'],
      incomeDefaults: loadIncomeDefaults_(ss, period),
      targetRows: targetRows,
      candidateIdentities: loadCandidateIdentities_(ss, period),
      // Drives the Type list on the target-month tab's add rows. Autodeduct
      // owners are a fixed pair, not a Master category.
      typeOptions: {
        'Saving': master.savingTypes,
        'Expense': master.expenseTypes,
        'Ibadah': master.ibadahTypes,
        'Autodeduct Jajan': JAJAN_OWNERS
      }
    };

    logInfo(context, 'source=' + period.sourceDateStr +
        ' categories=' + payload.categories.length +
        ' channels=' + payload.paymentChannels.length +
        ' candidates saving=' + payload.savingCandidates.length +
        ' expense=' + payload.expenseCandidates.length +
        ' ibadah=' + payload.ibadahCandidates.length +
        ' autodeduct=' + payload.autodeductCandidates.length +
        ' incomeDefaults=' + describeIncomeDefaults_(payload.incomeDefaults) +
        ' targetRows=' + payload.targetRows.length +
        ' alreadyInMonth=' + alreadyInMonth);

    return payload;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Every row already dated in the target month, for the dialog's second tab.
 *
 * The tab edits amounts, removes rows and adds new ones. Everything else the
 * row holds — channel, Cicilan, payments remaining, Sudah Bayar — travels out
 * here and back again untouched, because applyMonthlyDataChanges rewrites all
 * of a row's editable columns on an update. Dropping them from the payload
 * would clear the installment flag and its remaining count on any row whose
 * amount was edited, so they are carried deliberately, not incidentally.
 *
 * `signature` is the same stale-row guard the Monthly Data form uses, and
 * `identity` is the merge's own List + Type + Note/Channel key, so the dialog
 * can tell which of these rows a ticked candidate is about to overwrite.
 *
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {{targetDateStr: string}} period Resolved period.
 * @return {Array<Object>} Rows, grouped in TARGET_EDIT_SHEETS order.
 */
function loadTargetMonthRows_(ss, period) {
  var context = 'loadTargetMonthRows_';
  var C = LEDGER_COLUMNS;
  var rows = [];

  for (var i = 0; i < TARGET_EDIT_SHEETS.length; i++) {
    var sheetName = TARGET_EDIT_SHEETS[i];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      logInfo(context, 'Sheet not found, skipping: ' + sheetName);
      continue;
    }

    var values = readLedgerSnapshot_(sheet).values;
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (formatDateToYMD(row[C.DATE]) !== period.targetDateStr) continue;

      var amount = typeof row[C.AMOUNT] === 'number' ? row[C.AMOUNT] : 0;
      rows.push({
        sheet: sheetName,
        rowNum: r + 1,
        signature: rowSignature_(row),
        identity: sheetName + KEY_SEPARATOR + rowIdentityKey_(row, false),
        list: orPlaceholder_(row[C.LIST]),
        type: orPlaceholder_(row[C.TYPE]),
        amount: amount,
        amountFormatted: formatCurrency(amount),
        // Carried untouched so an amount edit cannot clear them.
        channel: row[C.CHANNEL] || '',
        isCicilan: isCheckedCell_(row[C.IS_CICILAN]),
        remainingMonth: (row[C.REMAINING] === null || row[C.REMAINING] === undefined)
            ? '' : String(row[C.REMAINING]),
        isPaid: isCheckedCell_(row[C.PAID]),
        owner: sheetName === 'Autodeduct Jajan' ? normaliseJajanOwner_(row[C.TYPE]) : ''
      });
    }
  }

  logInfo(context, 'target-month rows=' + rows.length);
  return rows;
}

/**
 * Splits a sheet's candidates into those still to roll over and those whose
 * item already sits in the target month.
 *
 * A candidate is "already in the month" when a target-month row carries the same
 * List + Type + Note/Channel — whatever its amount has since been edited to.
 * Each such candidate claims one row, the way mergeLedgerRows_ does, so the
 * claimed rows are flagged `fromRollover` for the dialog and the candidate is
 * dropped from the checklist: a re-run lists only what is genuinely missing, and
 * a row deleted from the month reappears as a candidate. Rows no candidate
 * claims (added by hand) stay unflagged.
 *
 * Hidden candidates are never ticked, so the generation neither overwrites
 * their rows nor loses them from the jajan total, which counts every existing
 * Autodeduct row no ticked candidate replaces.
 *
 * @param {string} sheetName Ledger sheet the candidates came from.
 * @param {Array<Object>} candidates Candidates from loadCandidates_.
 * @param {Array<Object>} targetRows Rows from loadTargetMonthRows_; flagged in place.
 * @param {{targetDateStr: string}} period Resolved period.
 * @return {{pending: Array<Object>, claimed: number}} Candidates left to roll over.
 */
function splitCandidatesByTarget_(sheetName, candidates, targetRows, period) {
  var queues = Object.create(null);
  targetRows.forEach(function (entry) {
    if (entry.sheet !== sheetName) return;
    (queues[entry.identity] = queues[entry.identity] || []).push(entry);
  });

  var pending = [];
  var claimed = 0;
  candidates.forEach(function (candidate) {
    var identity = sheetName + KEY_SEPARATOR + rowIdentityKey_(
        toLedgerRow_(period.targetDateStr, candidate, candidate.amount), false);
    var queue = queues[identity];
    if (queue && queue.length) {
      var matched = queue.shift();
      matched.fromRollover = true;
      // The M-1 figure, so the dialog can show what an edited row changed from.
      matched.rolloverAmount = candidate.amount;
      claimed++;
    } else {
      pending.push(candidate);
    }
  });
  return { pending: pending, claimed: claimed };
}

/**
 * The merge identity each rollover candidate would claim, keyed by uid.
 *
 * A ticked candidate overwrites the target-month row of the same identity
 * rather than adding a second one. The dialog uses this two ways: to drop a
 * claimed row from its jajan carry instead of counting it twice, and to warn
 * that a row edited or removed on the target-month tab is about to be written
 * over — or put straight back — by the rollover.
 *
 * The key is built server-side because rowIdentityKey_ tags values by type,
 * which the browser cannot reproduce from a candidate's display strings, and
 * namespaced by sheet because the same List + Type + Note/Channel can appear
 * on more than one ledger.
 *
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {{targetDateStr: string, sourceDateStr: string}} period Resolved period.
 * @return {!Object} Map of candidate uid -> identity key.
 */
function loadCandidateIdentities_(ss, period) {
  var identities = {};

  for (var s = 0; s < TARGET_EDIT_SHEETS.length; s++) {
    var sheetName = TARGET_EDIT_SHEETS[s];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) continue;

    var candidates = collectRolloverCandidates_(readLedgerSnapshot_(sheet), period);
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      identities[candidate.uid] = sheetName + KEY_SEPARATOR + rowIdentityKey_(
          toLedgerRow_(period.targetDateStr, candidate, candidate.amount), false);
    }
  }
  return identities;
}

/**
 * Rolls the source month's Income rows forward as the dialog's starting values.
 *
 * Income is the one section the dialog cannot offer as a checklist: the ledger
 * holds one row per person per category, and the form holds one box for each of
 * those, so there is nothing to tick — the M-1 figure is simply what the box
 * starts at. Every box stays editable, and a category with no row last month
 * starts at zero, so this only ever saves typing.
 *
 * Amounts are summed per person and category: nothing stops the ledger holding
 * two `Wiva / Bonus` rows in one month, and the dialog has a single box for it.
 *
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {{sourceDateStr: string}} period Resolved period.
 * @return {!Object} {person: {category: amount}} for every tracked person.
 */
function loadIncomeDefaults_(ss, period) {
  var context = 'loadIncomeDefaults_';
  var defaults = {};
  var byPerson = Object.create(null);
  for (var p = 0; p < INCOME_PERSONS.length; p++) {
    defaults[INCOME_PERSONS[p]] = {};
    byPerson[INCOME_PERSONS[p].trim().toLowerCase()] = INCOME_PERSONS[p];
  }

  var sheet = ss.getSheetByName('Income');
  if (!sheet) {
    logInfo(context, 'Income sheet not found; every category starts at zero.');
    return defaults;
  }

  var C = LEDGER_COLUMNS;
  var values = readLedgerSnapshot_(sheet).values;
  var skippedOwners = 0;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (formatDateToYMD(row[C.DATE]) !== period.sourceDateStr) continue;

    // Column B is the person on Income, column C the category.
    var person = byPerson[String(row[C.LIST]).trim().toLowerCase()];
    if (!person) {
      skippedOwners++;
      continue;
    }

    var category = String(row[C.TYPE]).trim();
    if (category === '') continue;

    var amount = Number(row[C.AMOUNT]);
    if (!isFinite(amount) || amount <= 0) continue;

    defaults[person][category] = (defaults[person][category] || 0) + amount;
  }

  if (skippedOwners > 0) {
    logInfo(context, skippedOwners + ' ' + period.sourceDateStr +
        ' income row(s) belong to someone other than ' + INCOME_PERSONS.join('/') +
        ' and were not offered as defaults.');
  }
  return defaults;
}

/**
 * @param {Object} defaults Map from loadIncomeDefaults_.
 * @return {string} Per-person category counts, with no amounts.
 */
function describeIncomeDefaults_(defaults) {
  var parts = [];
  for (var i = 0; i < INCOME_PERSONS.length; i++) {
    var person = INCOME_PERSONS[i];
    parts.push(person + '=' + Object.keys((defaults && defaults[person]) || {}).length);
  }
  return parts.join(' ');
}

/**
 * Reads one ledger sheet and returns its rollover candidates.
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {string} sheetName Ledger sheet name.
 * @param {{targetDateStr: string, sourceDateStr: string}} period Resolved period.
 * @return {Array<Object>} Candidates, or [] when the sheet is missing.
 */
function loadCandidates_(ss, sheetName, period) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    logInfo('loadCandidates_', 'Sheet not found: ' + sheetName);
    return [];
  }
  return collectRolloverCandidates_(readLedgerSnapshot_(sheet), period);
}

/**
 * Finds the rows worth offering as rollover candidates:
 *   1. Active installments dated strictly *before* the target month, keeping
 *      each item's most recent state — the latest month it appears in, not
 *      necessarily M-1. An item whose remaining count is 1 or less has already
 *      made its final payment and is dropped.
 *   2. Plain, non-installment rows dated in the source month (M-1).
 *
 * Pass 1 spans every earlier month on purpose, so an installment that was
 * paused for a few months still resumes from where it left off: the count only
 * moves when a row is actually written, never per calendar month.
 *
 * The "before the target month" cut-off is what makes a re-run idempotent. Rows
 * the rollover itself wrote sit *in* the target month, so they are invisible to
 * the scan and a second Generate reads the same M-1 state as the first: a July
 * installment with 3 payments left always produces 2 in August, never 1.
 *
 * Jajan rows in the Expense ledger are skipped: those are recalculated from the
 * allocation pool rather than rolled over.
 *
 * @param {Object} snapshot Snapshot from readLedgerSnapshot_.
 * @param {{targetDateStr: string, sourceDateStr: string}} period Resolved period.
 * @return {Array<Object>} Candidates, installments first, then plain rows.
 */
function collectRolloverCandidates_(snapshot, period) {
  var values = snapshot.values;
  if (!values || values.length <= 1) return [];

  var C = LEDGER_COLUMNS;
  var sheetName = snapshot.name;
  var skipJajanRows = (sheetName === 'Expense');

  var candidates = [];
  var latest = Object.create(null);
  var order = [];

  // Pass 1 — active installments from any month before the target month.
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!isCheckedCell_(row[C.IS_CICILAN])) continue;
    if (skipJajanRows && isJajanRow_(row[C.TYPE])) continue;

    var rowDateStr = formatDateToYMD(row[C.DATE]);
    // 'yyyy-MM-01' keys are fixed width, so string order is date order.
    if (!rowDateStr || rowDateStr >= period.targetDateStr) continue;

    var remaining = parseInt(row[C.REMAINING], 10);
    if (isNaN(remaining)) continue;

    var key = ledgerIdentity_(row[C.LIST], row[C.TYPE], row[C.CHANNEL]);
    var current = latest[key];

    if (!current || isMoreRecentState_(rowDateStr, remaining, current)) {
      if (!current) order.push(key);
      latest[key] = {
        rowIndex: r, row: row, dateStr: rowDateStr, remaining: remaining
      };
    }
  }

  var claimed = Object.create(null);
  for (var i = 0; i < order.length; i++) {
    var state = latest[order[i]];
    // 1 payment left means the last installment has already been booked.
    if (state.remaining <= 1) continue;
    candidates.push(
        buildCandidate_(sheetName, state.rowIndex, state.row, true, state.remaining));
    claimed[order[i]] = true;
  }

  // Pass 2 — plain rows from the source month that no installment covers.
  for (var p = 1; p < values.length; p++) {
    var plainRow = values[p];
    if (formatDateToYMD(plainRow[C.DATE]) !== period.sourceDateStr) continue;
    if (skipJajanRows && isJajanRow_(orPlaceholder_(plainRow[C.TYPE]))) continue;
    if (isCheckedCell_(plainRow[C.IS_CICILAN])) continue;

    var plain = buildCandidate_(sheetName, p, plainRow, false, 0);
    if (claimed[candidateIdentity_(plain)]) continue;
    candidates.push(plain);
  }

  return candidates;
}

/**
 * Decides which of two rows for the same installment describes its current
 * state. The later month always wins: a restructure can raise the payment count
 * as easily as lower it, and picking the smaller count would let a stale older
 * row (and its old amount) override the restructured one. Two rows in the same
 * month are a data slip, so the smaller count breaks the tie.
 *
 * With an untouched installment the two rules agree — the latest month is also
 * the one with the fewest payments left.
 *
 * @param {string} dateStr Month key of the row being considered.
 * @param {number} remaining Payments remaining on that row.
 * @param {{dateStr: string, remaining: number}} current Best row found so far.
 * @return {boolean} True when the new row should replace the current one.
 */
function isMoreRecentState_(dateStr, remaining, current) {
  if (dateStr !== current.dateStr) return dateStr > current.dateStr;
  return remaining < current.remaining;
}

/**
 * Shapes one ledger row into the candidate object the dialog renders.
 * @param {string} sheetName Sheet the row came from.
 * @param {number} rowIndex 0-based index within the snapshot values.
 * @param {Array<*>} row Raw row values.
 * @param {boolean} isCicilan Whether this is an active installment.
 * @param {number} remainingMonth Payments remaining (installments only).
 * @return {Object} Candidate.
 */
function buildCandidate_(sheetName, rowIndex, row, isCicilan, remainingMonth) {
  var C = LEDGER_COLUMNS;
  var amount = typeof row[C.AMOUNT] === 'number' ? row[C.AMOUNT] : 0;
  var list = orPlaceholder_(row[C.LIST]);
  var remaining = isCicilan ? remainingMonth : 0;
  var sheetRow = rowIndex + 1;

  return {
    uid: sheetName + '|' + sheetRow + '|' + list + '|' + amount + '|' + remaining +
        '|' + (isCicilan ? 'cicilan' : 'regular'),
    list: list,
    whoType: orPlaceholder_(row[C.TYPE]),
    amount: amount,
    noteChannel: orPlaceholder_(row[C.CHANNEL]),
    isCicilan: isCicilan,
    remainingMonth: remaining,
    amountFormatted: formatCurrency(amount)
  };
}

/**
 * Identity of a ledger item: List + Type + Channel, matching the columns the
 * merge itself keys on. Amount is deliberately excluded so an installment stays
 * one item across months even after its amount is overridden.
 * @param {*} list Value of the List column.
 * @param {*} type Value of the Type column.
 * @param {*} channel Value of the Note/Channel column.
 * @return {string} Identity key.
 */
function ledgerIdentity_(list, type, channel) {
  return orPlaceholder_(list) + KEY_SEPARATOR + orPlaceholder_(type) +
      KEY_SEPARATOR + orPlaceholder_(channel);
}

/**
 * Identity of a candidate, used to stop a plain row duplicating an installment.
 * @param {Object} candidate Candidate object.
 * @return {string} Identity key.
 */
function candidateIdentity_(candidate) {
  return ledgerIdentity_(candidate.list, candidate.whoType, candidate.noteChannel);
}

/* ==========================================================================
 * Generation
 * ========================================================================== */

/**
 * Executes the upsert-based monthly rollover across every ledger sheet.
 * @param {Object} formData Configuration submitted by the dialog.
 * @return {Object} Audit report consumed by LoadingSummaryDialog.
 */
function executeMonthlyGeneration(formData) {
  var context = 'executeMonthlyGeneration';
  try {
    var input = validateGenerationInput_(formData);
    logInfo(context, 'target=' + input.period.targetDateStr +
        ' source=' + input.period.sourceDateStr + ' ' + describeSelections_(formData));

    var ss = getBook_();

    // Edits made on the target-month tab land first, so every snapshot below —
    // and therefore the jajan arithmetic — sees the month the user just fixed
    // up. This never touches the candidate scan, which still reads M-1 only.
    applyTargetMonthEdits_(formData, input.period.targetDateStr);

    var snapshots = readGenerationSnapshots_(ss);

    // Autodeduct rows are resolved first: they reduce each person's jajan pool.
    var autodeduct = buildAutodeductPlan_(snapshots['Autodeduct Jajan'], input);
    var allocation = calculateJajanAllocation_(input, autodeduct);
    logInfo(context, 'jajan pool base=' + allocation.combinedBase +
        ' gross=' + Math.round(allocation.grossPool) +
        ' netWiva=' + allocation.wivaNet + ' netJane=' + allocation.janeNet +
        ' autodeductWiva=' + autodeduct.wivaTotal +
        ' autodeductJane=' + autodeduct.janeTotal +
        ' carriedTargetMonthRows=' + autodeduct.carriedRows);

    var report = {
      meta: {
        srcStr: input.period.sourceDateStr,
        tgtStr: input.period.targetDateStr,
        totalUpdated: 0,
        totalInserted: 0
      },
      sheets: {}
    };

    for (var s = 0; s < GENERATION_SHEETS.length; s++) {
      var sheetName = GENERATION_SHEETS[s];
      var snapshot = snapshots[sheetName];
      if (!snapshot) continue;

      var rows = buildRowsForSheet_(sheetName, snapshot, input, allocation, autodeduct);
      var merge = mergeLedgerRows_(snapshot, input.period.targetDateStr, rows);

      report.sheets[sheetName] = summariseMerge_(rows, merge);
      report.meta.totalUpdated += merge.updated;
      report.meta.totalInserted += merge.inserted;
    }

    Logger.log(buildAuditLog_(report));
    logInfo(context, 'Completed: updated=' + report.meta.totalUpdated +
        ' inserted=' + report.meta.totalInserted);

    return report;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Applies the target-month edits the dialog staged, before the rollover reads
 * a single sheet. Delegates to applyMonthlyDataChanges so there is one code
 * path that writes ledger edits, signature guard and all.
 *
 * @param {Object} formData Raw configuration from the dialog.
 * @param {string} targetDateStr Month the rollover is generating.
 */
function applyTargetMonthEdits_(formData, targetDateStr) {
  var context = 'applyTargetMonthEdits_';
  var changes = formData && formData.targetMonthChanges;
  if (!changes) return;

  var counts = [changes.updates, changes.deletions, changes.additions]
      .map(function (list) { return (list && list.length) || 0; });
  if (counts[0] + counts[1] + counts[2] === 0) return;

  logInfo(context, 'updates=' + counts[0] + ' deletions=' + counts[1] +
      ' additions=' + counts[2]);

  // The dialog sends its own month; the rollover's target is authoritative.
  changes.month = targetDateStr.slice(0, 7);

  var result = applyMonthlyDataChanges(changes);
  if (!result || !result.success) {
    throw new Error('Target-month edits could not be applied: ' +
        ((result && result.error) || 'unknown error'));
  }
  if (result.skipped && result.skipped.length) {
    logInfo(context, 'Skipped: ' + result.skipped.join('; '));
  }
  logInfo(context, 'Applied: updated=' + result.updated +
      ' deleted=' + result.deleted + ' added=' + result.added);
}

/**
 * Reads every generation sheet exactly once.
 * @param {Spreadsheet} ss Active spreadsheet.
 * @return {!Object} Map of sheet name -> snapshot (missing sheets are absent).
 */
function readGenerationSnapshots_(ss) {
  var snapshots = {};
  for (var i = 0; i < GENERATION_SHEETS.length; i++) {
    var name = GENERATION_SHEETS[i];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      logInfo('readGenerationSnapshots_', 'Sheet not found, skipping: ' + name);
      continue;
    }
    snapshots[name] = readLedgerSnapshot_(sheet);
  }
  return snapshots;
}

/**
 * Normalises and validates the dialog payload before anything is written.
 * @param {Object} formData Raw configuration from the dialog.
 * @return {Object} Sanitised input.
 */
function validateGenerationInput_(formData) {
  if (!formData || typeof formData !== 'object') {
    throw new Error('Missing generation configuration.');
  }

  var period = resolvePeriod_(formData.targetMonth, formData.targetYear);
  var wivaRate = parseRate_(formData.wivaJajanRate, 'Wiva jajan split');
  var janeRate = parseRate_(formData.janeJajanRate, 'Jane jajan split');

  if (Math.abs(wivaRate + janeRate - 100) > 0.01) {
    logInfo('validateGenerationInput_',
        'WARNING: jajan split totals ' + (wivaRate + janeRate) + '%, expected 100%');
  }

  return {
    period: period,
    wivaIncome: sanitiseIncomeMap_(formData.wivaIncome),
    janeIncome: sanitiseIncomeMap_(formData.janeIncome),
    wivaJajanCategories: toLowerLookupSet_(
        formData.wivaJajanIncomeCategories || [DEFAULT_JAJAN_INCOME_CATEGORY]),
    janeJajanCategories: toLowerLookupSet_(
        formData.janeJajanIncomeCategories || [DEFAULT_JAJAN_INCOME_CATEGORY]),
    jajanPoolRate: parseRate_(formData.jajanPoolRate, 'Jajan pool rate'),
    wivaJajanRate: wivaRate,
    janeJajanRate: janeRate,
    wivaJajanChannel: sanitiseChannel_(formData.wivaJajanChannel, DEFAULT_WIVA_JAJAN_CHANNEL),
    janeJajanChannel: sanitiseChannel_(formData.janeJajanChannel, DEFAULT_JANE_JAJAN_CHANNEL),
    selections: {
      'Saving': toLookupSet_(formData.selectedSaving),
      'Expense': toLookupSet_(formData.selectedExpense),
      'Ibadah': toLookupSet_(formData.selectedIbadah)
    },
    selectedAutodeduct: toLookupSet_(formData.selectedAutodeduct),
    amountOverrides: sanitiseAmountOverrides_(formData.amountOverrides)
  };
}

/**
 * Normalises the per-row rollover amount overrides sent by the dialog. Anything
 * that is not a finite, non-negative number is dropped, so a malformed entry
 * silently falls back to the candidate's own M-1 amount instead of writing junk
 * into the ledger.
 * @param {Object} overrides Raw {uid: amount} map.
 * @return {!Object} Map of uid -> amount, prototype-less.
 */
function sanitiseAmountOverrides_(overrides) {
  var clean = Object.create(null);
  if (!overrides || typeof overrides !== 'object') return clean;

  for (var uid in overrides) {
    if (!Object.prototype.hasOwnProperty.call(overrides, uid)) continue;

    // Number(null) and Number('') are both 0, which would silently zero a row.
    var raw = overrides[uid];
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;

    var amount = Number(raw);
    if (!isFinite(amount) || amount < 0) continue;
    clean[uid] = amount;
  }
  return clean;
}

/**
 * The amount a candidate should be written with: its override when the user
 * typed one, otherwise the amount carried over from M-1.
 * @param {Object} candidate Rollover candidate.
 * @param {Object} overrides Sanitised {uid: amount} map.
 * @return {number} Amount for the target-month row.
 */
function resolveAmount_(candidate, overrides) {
  var override = overrides[candidate.uid];
  return override === undefined ? candidate.amount : override;
}

/**
 * Resolves the target month and its M-1 source month.
 * @param {number} monthIndex 0-based month index.
 * @param {number} year Full year.
 * @return {{targetDateStr: string, sourceDateStr: string}} Period keys.
 */
function resolvePeriod_(monthIndex, year) {
  var idx = parseInt(monthIndex, 10);
  var yr = parseInt(year, 10);

  if (isNaN(idx) || idx < 0 || idx > 11) {
    throw new Error('Invalid target month index: ' + monthIndex);
  }
  if (isNaN(yr) || yr < 2000 || yr > 2100) {
    throw new Error('Invalid target year: ' + year);
  }

  return {
    targetDateStr: monthStartString_(yr, idx),
    sourceDateStr: monthStartString_(yr, idx - 1)
  };
}

/**
 * @param {*} value Raw percentage from the dialog.
 * @param {string} label Field name used in the error message.
 * @return {number} A percentage in the 0-100 range.
 */
function parseRate_(value, label) {
  var rate = Number(value);
  if (value === null || value === undefined || value === '') rate = 0;
  if (!isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error(label + ' must be between 0 and 100 (received: ' + value + ').');
  }
  return rate;
}

/**
 * @param {Object} incomeMap Raw {category: amount} map.
 * @return {!Object} Map with finite, non-negative numeric amounts only.
 */
function sanitiseIncomeMap_(incomeMap) {
  var clean = {};
  if (!incomeMap || typeof incomeMap !== 'object') return clean;
  for (var category in incomeMap) {
    if (!Object.prototype.hasOwnProperty.call(incomeMap, category)) continue;
    var amount = Number(incomeMap[category]);
    if (!isFinite(amount) || amount < 0) continue;
    clean[category] = amount;
  }
  return clean;
}

/**
 * @param {*} value Raw channel name.
 * @param {string} fallback Channel to use when the value is blank.
 * @return {string} Trimmed channel name.
 */
function sanitiseChannel_(value, fallback) {
  var text = (value === null || value === undefined) ? '' : String(value).trim();
  return text === '' ? fallback : text;
}

/**
 * Works out what each person will actually be autodeducting in the target
 * month, split per person, and the rows the merge should write.
 *
 * The total is deliberately **everything that will sit in the target month once
 * this run finishes**, not just what rolled over from M-1:
 *
 *   - every ticked candidate, at its overridden amount when one was typed; plus
 *   - every autodeduct row **already in the target month** that no ticked
 *     candidate is going to replace.
 *
 * That second half is what makes the Jajan figure honest. Rows can reach the
 * target month without passing through the rollover at all — the Monthly Data
 * form can add next month's autodeductions before that month is ever
 * generated, and a previous run's rows are sitting there on a re-run. Counting
 * only the candidates would write a Jajan budget that ignores them, silently
 * undoing the deduction the form applied when the row was created.
 *
 * Double counting is avoided the same way the merge avoids it: a planned row
 * claims one existing row of the same identity, because it is about to
 * overwrite it. See mergeLedgerRows_.
 *
 * @param {Object} snapshot Snapshot of the Autodeduct Jajan sheet (may be undefined).
 * @param {Object} input Sanitised input.
 * @return {{rows: Array<Array<*>>, wivaTotal: number, janeTotal: number,
 *           carriedRows: number}} Plan.
 */
function buildAutodeductPlan_(snapshot, input) {
  var plan = { rows: [], wivaTotal: 0, janeTotal: 0, carriedRows: 0 };
  if (!snapshot) return plan;

  var candidates = collectRolloverCandidates_(snapshot, input.period);
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (!input.selectedAutodeduct[candidate.uid]) continue;

    var amount = resolveAmount_(candidate, input.amountOverrides);
    addAutodeductTotal_(plan, candidate.whoType, amount);
    plan.rows.push(toLedgerRow_(input.period.targetDateStr, candidate, amount));
  }

  addExistingAutodeductions_(plan, snapshot, input.period.targetDateStr);
  return plan;
}

/**
 * Adds one autodeduction to its owner's total.
 *
 * An owner cell naming neither person is skipped rather than folded into Jane,
 * which is what an owner-or-else test used to do: a typo in the Type column
 * quietly moved somebody else's budget.
 *
 * @param {Object} plan Accumulator from buildAutodeductPlan_.
 * @param {*} ownerCell Type column of the autodeduct row.
 * @param {number} amount Amount to deduct.
 */
function addAutodeductTotal_(plan, ownerCell, amount) {
  var value = Number(amount);
  if (!isFinite(value) || value <= 0) return;

  var owner = normaliseJajanOwner_(ownerCell);
  if (owner === 'Wiva') {
    plan.wivaTotal += value;
  } else if (owner === 'Jane') {
    plan.janeTotal += value;
  } else {
    logInfo('addAutodeductTotal_', 'Autodeduct row owned by "' + ownerCell +
        '" counts towards nobody; expected ' + JAJAN_OWNERS.join(' or ') + '.');
  }
}

/**
 * Counts the autodeductions already dated in the target month that this run
 * will leave standing, so the Jajan budget reflects them too.
 * @param {Object} plan Accumulator from buildAutodeductPlan_, mutated in place.
 * @param {Object} snapshot Snapshot of the Autodeduct Jajan sheet.
 * @param {string} targetDateStr Target month key.
 */
function addExistingAutodeductions_(plan, snapshot, targetDateStr) {
  var C = LEDGER_COLUMNS;
  var values = snapshot.values;
  if (!values || values.length <= 1) return;

  var body = values.slice(1);
  var matchIndex = buildTargetMonthIndex_(body, targetDateStr, false);

  // Each planned row is about to overwrite one existing row of the same
  // identity, so that row's own amount must not be counted as well.
  for (var p = 0; p < plan.rows.length; p++) {
    var queue = matchIndex[rowIdentityKey_(plan.rows[p], false)];
    if (queue && queue.length) queue.shift();
  }

  // Prototype-less index, so every remaining key is a real target-month row.
  for (var key in matchIndex) {
    var unclaimed = matchIndex[key];
    for (var u = 0; u < unclaimed.length; u++) {
      var row = body[unclaimed[u]];
      addAutodeductTotal_(plan, row[C.TYPE], row[C.AMOUNT]);
      plan.carriedRows++;
    }
  }
}

/**
 * @param {*} owner Value of the Type column.
 * @return {boolean} True when the row belongs to Wiva (also recorded as "Rio").
 */
function isWivaOwner_(owner) {
  return normaliseJajanOwner_(owner) === 'Wiva';
}

/**
 * Derives each person's spendable jajan budget for the target month:
 *   selected income -> pool rate -> personal split -> minus autodeductions.
 * @param {Object} input Sanitised input.
 * @param {Object} autodeduct Plan from buildAutodeductPlan_.
 * @return {Object} Allocation figures (net values rounded to whole IDR).
 */
function calculateJajanAllocation_(input, autodeduct) {
  var wivaBase = sumSelectedIncome_(input.wivaIncome, input.wivaJajanCategories);
  var janeBase = sumSelectedIncome_(input.janeIncome, input.janeJajanCategories);
  var combinedBase = wivaBase + janeBase;

  var grossPool = combinedBase * (input.jajanPoolRate / 100);
  var wivaGross = grossPool * (input.wivaJajanRate / 100);
  var janeGross = grossPool * (input.janeJajanRate / 100);

  return {
    combinedBase: combinedBase,
    grossPool: grossPool,
    wivaNet: Math.round(Math.max(0, wivaGross - autodeduct.wivaTotal)),
    janeNet: Math.round(Math.max(0, janeGross - autodeduct.janeTotal))
  };
}

/**
 * @param {Object} incomeMap Sanitised {category: amount} map.
 * @param {Object} categorySet Lowercased lookup of categories that count.
 * @return {number} Total income feeding the jajan pool.
 */
function sumSelectedIncome_(incomeMap, categorySet) {
  var total = 0;
  for (var category in incomeMap) {
    if (!Object.prototype.hasOwnProperty.call(incomeMap, category)) continue;
    if (categorySet[category.toString().trim().toLowerCase()]) {
      total += incomeMap[category];
    }
  }
  return total;
}

/* ==========================================================================
 * Row building
 * ========================================================================== */

/**
 * Produces the rows a single sheet should hold for the target month.
 * @param {string} sheetName Sheet being generated.
 * @param {Object} snapshot Snapshot of that sheet.
 * @param {Object} input Sanitised input.
 * @param {Object} allocation Jajan allocation figures.
 * @param {Object} autodeduct Autodeduct plan.
 * @return {Array<Array<*>>} Candidate rows for the merge.
 */
function buildRowsForSheet_(sheetName, snapshot, input, allocation, autodeduct) {
  if (sheetName === 'Income') return buildIncomeRows_(input);
  if (sheetName === 'Autodeduct Jajan') return autodeduct.rows;
  return buildRolloverRows_(sheetName, snapshot, input, allocation);
}

/**
 * @param {Object} input Sanitised input.
 * @return {Array<Array<*>>} One row per person per income category.
 */
function buildIncomeRows_(input) {
  var rows = [];
  appendIncomeRows_(rows, input.period.targetDateStr, 'Wiva', input.wivaIncome);
  appendIncomeRows_(rows, input.period.targetDateStr, 'Jane', input.janeIncome);
  return rows;
}

/**
 * @param {Array<Array<*>>} rows Accumulator.
 * @param {string} dateStr Target month key.
 * @param {string} person Row owner.
 * @param {Object} incomeMap Sanitised {category: amount} map.
 */
function appendIncomeRows_(rows, dateStr, person, incomeMap) {
  for (var category in incomeMap) {
    if (!Object.prototype.hasOwnProperty.call(incomeMap, category)) continue;
    rows.push([dateStr, person, category, incomeMap[category]]);
  }
}

/**
 * Builds the rows for a checklist-driven ledger, plus the two recalculated
 * Jajan rows that only the Expense sheet carries.
 * @param {string} sheetName Ledger sheet name.
 * @param {Object} snapshot Snapshot of that sheet.
 * @param {Object} input Sanitised input.
 * @param {Object} allocation Jajan allocation figures.
 * @return {Array<Array<*>>} Candidate rows.
 */
function buildRolloverRows_(sheetName, snapshot, input, allocation) {
  var rows = [];
  var selected = input.selections[sheetName];
  var isExpense = (sheetName === 'Expense');

  if (selected) {
    var candidates = collectRolloverCandidates_(snapshot, input.period);
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!selected[candidate.uid]) continue;
      if (isExpense && isJajanRow_(candidate.whoType)) continue;
      rows.push(toLedgerRow_(input.period.targetDateStr, candidate,
          resolveAmount_(candidate, input.amountOverrides)));
    }
  }

  if (isExpense) {
    rows.push(buildJajanRow_(input.period.targetDateStr, 'Wiva',
        allocation.wivaNet, input.wivaJajanChannel));
    rows.push(buildJajanRow_(input.period.targetDateStr, 'Jane',
        allocation.janeNet, input.janeJajanChannel));
  }

  return rows;
}

/**
 * Converts a rollover candidate into a target-month ledger row, burning one
 * installment payment and resetting the "Sudah Bayar?" checkbox.
 * @param {string} targetDateStr Target month key.
 * @param {Object} candidate Rollover candidate.
 * @param {number} amount Amount to write (override, or the candidate's own).
 * @return {Array<*>} Ledger row.
 */
function toLedgerRow_(targetDateStr, candidate, amount) {
  return [
    targetDateStr,
    candidate.list,
    candidate.whoType,
    amount,
    candidate.noteChannel,
    candidate.isCicilan,
    candidate.isCicilan ? candidate.remainingMonth - 1 : '',
    false
  ];
}

/**
 * @param {string} targetDateStr Target month key.
 * @param {string} person Row owner.
 * @param {number} netAmount Net jajan budget.
 * @param {string} channel Payment channel.
 * @return {Array<*>} Ledger row for the recalculated Jajan expense.
 */
function buildJajanRow_(targetDateStr, person, netAmount, channel) {
  return [targetDateStr, person, 'Jajan', netAmount, channel, false, '', false];
}

/* ==========================================================================
 * Merge
 * ========================================================================== */

/**
 * Upserts candidate rows into a sheet for the target month.
 *
 * Existing target-month rows are indexed by their identity columns so each
 * candidate finds its match in one lookup; every row is claimed at most once,
 * so duplicated candidates append instead of overwriting the same row. Only the
 * changed tail of the sheet is written back, leaving untouched history alone.
 *
 * @param {Object} snapshot Snapshot from readLedgerSnapshot_.
 * @param {string} targetDateStr Target month key.
 * @param {Array<Array<*>>} candidates Rows to merge in.
 * @return {{updated: number, inserted: number,
 *           candidateResults: Array<{status: string, prevAmount: number}>}} Result.
 */
function mergeLedgerRows_(snapshot, targetDateStr, candidates) {
  var C = LEDGER_COLUMNS;
  var totalColumns = snapshot.totalColumns;
  var isIncome = (snapshot.name === 'Income');
  var hasHeader = snapshot.values.length > 0;
  var body = hasHeader ? snapshot.values.slice(1) : [];

  var matchIndex = buildTargetMonthIndex_(body, targetDateStr, isIncome);
  var appended = [];
  var candidateResults = [];
  var updated = 0;
  var firstDirtyRow = -1;

  for (var c = 0; c < candidates.length; c++) {
    var candidate = candidates[c];
    var queue = matchIndex[rowIdentityKey_(candidate, isIncome)];

    if (queue && queue.length > 0) {
      // Update in place: the row keeps its position and its Date/List/Type,
      // so a row you added yourself is amended here, never replaced or moved.
      var rowIdx = queue.shift();
      var existing = body[rowIdx];
      var prevAmount = typeof existing[C.AMOUNT] === 'number' ? existing[C.AMOUNT] : 0;

      existing[C.AMOUNT] = candidate[C.AMOUNT];
      if (!isIncome) {
        existing[C.IS_CICILAN] = candidate[C.IS_CICILAN];
        existing[C.REMAINING] = candidate[C.REMAINING];
        existing[C.PAID] = candidate[C.PAID];
      }

      updated++;
      if (firstDirtyRow === -1 || rowIdx < firstDirtyRow) firstDirtyRow = rowIdx;
      candidateResults.push({ status: 'updated', prevAmount: prevAmount });
    } else {
      appended.push(padRow_(candidate.slice(), totalColumns));
      candidateResults.push({ status: 'inserted', prevAmount: 0 });
    }
  }

  writeMergedRows_(snapshot, body, appended, firstDirtyRow);

  return { updated: updated, inserted: appended.length, candidateResults: candidateResults };
}

/**
 * Indexes existing target-month rows by identity so matching is O(1).
 * Indices stay ascending, so the topmost unclaimed row always wins.
 * @param {Array<Array<*>>} body Data rows (header excluded).
 * @param {string} targetDateStr Target month key.
 * @param {boolean} isIncome Whether the sheet is the Income ledger.
 * @return {!Object} Map of identity key -> array of row indices.
 */
function buildTargetMonthIndex_(body, targetDateStr, isIncome) {
  var index = Object.create(null);
  for (var i = 0; i < body.length; i++) {
    if (formatDateToYMD(body[i][LEDGER_COLUMNS.DATE]) !== targetDateStr) continue;
    var key = rowIdentityKey_(body[i], isIncome);
    if (index[key]) index[key].push(i);
    else index[key] = [i];
  }
  return index;
}

/**
 * Identity of a ledger row: List + Type, plus Channel on every sheet except
 * Income (where a person can only hold one row per category).
 * @param {Array<*>} row Ledger row.
 * @param {boolean} isIncome Whether the sheet is the Income ledger.
 * @return {string} Identity key.
 */
function rowIdentityKey_(row, isIncome) {
  var C = LEDGER_COLUMNS;
  var key = strictKey_(row[C.LIST]) + KEY_SEPARATOR + strictKey_(row[C.TYPE]);
  if (!isIncome) key += KEY_SEPARATOR + strictKey_(row[C.CHANNEL]);
  return key;
}

/**
 * Writes back only what the merge touched: the first modified row onwards, plus
 * the appended block, then tidies genuinely blank rows below the ledger.
 * @param {Object} snapshot Snapshot from readLedgerSnapshot_.
 * @param {Array<Array<*>>} body Data rows after in-place updates.
 * @param {Array<Array<*>>} appended Newly inserted rows.
 * @param {number} firstDirtyRow Index of the first updated row, or -1.
 */
function writeMergedRows_(snapshot, body, appended, firstDirtyRow) {
  var outputRows = appended.length > 0 ? body.concat(appended) : body;
  if (snapshot.values.length === 0 && outputRows.length === 0) return;

  var writeStart = -1;
  if (appended.length > 0) writeStart = body.length;
  if (firstDirtyRow !== -1 && (writeStart === -1 || firstDirtyRow < writeStart)) {
    writeStart = firstDirtyRow;
  }

  if (writeStart !== -1) {
    var block = outputRows.slice(writeStart);
    // The sheet may have been trimmed to its data, leaving no spare rows.
    ensureRowCapacity_(snapshot.sheet, 1 + writeStart + block.length);
    snapshot.sheet
        .getRange(2 + writeStart, 1, block.length, snapshot.totalColumns)
        .setValues(block);
  }

  clearBlankTrailingRows_(snapshot, 1 + outputRows.length);
}

/**
 * Tidies the rows below the ledger, and only the ones that hold nothing.
 *
 * readLedgerSnapshot_ stops at the last row with a date in column A, so a row
 * you typed without filling the date sits *below* the ledger as far as the
 * merge is concerned. Clearing that span wholesale would silently destroy it,
 * which is why every row is inspected first: a row with any content in any
 * ledger column is left alone and reported, and only rows that are blank
 * end to end (a formula rendering to '', a stray space) are cleared.
 *
 * The upsert never shrinks the ledger, so this can never be undoing the merge's
 * own work — it only ever touches rows the merge did not write.
 *
 * @param {Object} snapshot Snapshot from readLedgerSnapshot_.
 * @param {number} lastWrittenRow Last row the merge is responsible for.
 */
function clearBlankTrailingRows_(snapshot, lastWrittenRow) {
  var context = 'clearBlankTrailingRows_';
  var trailingCount = snapshot.absoluteLastRow - lastWrittenRow;
  if (trailingCount <= 0) return;

  var range = snapshot.sheet.getRange(
      lastWrittenRow + 1, 1, trailingCount, snapshot.totalColumns);
  var values = range.getValues();

  var keptRows = 0;
  for (var i = 0; i < values.length; i++) {
    if (!isBlankRow_(values[i])) {
      keptRows++;
      continue;
    }
    range.offset(i, 0, 1, snapshot.totalColumns).clearContent();
  }

  if (keptRows > 0) {
    logInfo(context, snapshot.name + ': left ' + keptRows +
        ' row(s) below the last dated row untouched (they hold data). ' +
        'Add a date in column A to bring them into the ledger.');
  }
}

/**
 * @param {Array<*>} row Row values.
 * @return {boolean} True when every cell is empty or whitespace only.
 */
function isBlankRow_(row) {
  for (var i = 0; i < row.length; i++) {
    var cell = row[i];
    if (cell === null || cell === undefined) continue;
    if (String(cell).trim() !== '') return false;
  }
  return true;
}

/* ==========================================================================
 * Reporting
 * ========================================================================== */

/**
 * Turns a merge result into the per-sheet block the summary dialog renders.
 * Rows are reported grouped by payment channel, biggest amount first, which is
 * the order the ledgers are actually reconciled in.
 * @param {Array<Array<*>>} candidates Rows that were merged.
 * @param {Object} merge Result from mergeLedgerRows_.
 * @return {{updated: number, inserted: number, appended: Array<Object>}} Block.
 */
function summariseMerge_(candidates, merge) {
  var C = LEDGER_COLUMNS;
  var details = [];

  for (var i = 0; i < candidates.length; i++) {
    var row = candidates[i];
    var result = merge.candidateResults[i];
    var amount = Number(row[C.AMOUNT]);
    if (!isFinite(amount)) amount = 0;

    details.push({
      list: row[C.LIST],
      type: row[C.TYPE],
      channel: row[C.CHANNEL] || '',
      amount: amount,
      amountFormatted: formatCurrency(row[C.AMOUNT]),
      status: result.status,
      prevAmount: result.prevAmount,
      prevAmountFormatted: formatCurrency(result.prevAmount),
      info: isCheckedCell_(row[C.IS_CICILAN]) || row[C.IS_CICILAN] === 'true'
          ? ' [Cicilan - ' + row[C.REMAINING] + ' left]'
          : ''
    });
  }

  details.sort(byChannelThenAmountDesc_);
  return { updated: merge.updated, inserted: merge.inserted, appended: details };
}

/**
 * Report order: payment channel A-Z, then the largest amounts first inside each
 * channel. Rows with no channel (Income) collect together at the top.
 * @param {Object} a First detail row.
 * @param {Object} b Second detail row.
 * @return {number} Comparator result.
 */
function byChannelThenAmountDesc_(a, b) {
  var channelA = String(a.channel || '').trim().toLowerCase();
  var channelB = String(b.channel || '').trim().toLowerCase();
  if (channelA !== channelB) return channelA.localeCompare(channelB);
  return (Number(b.amount) || 0) - (Number(a.amount) || 0);
}

/**
 * Renders the human-readable audit trail written to the Apps Script log.
 * @param {Object} report Report produced by executeMonthlyGeneration.
 * @return {string} Multi-line audit log.
 */
function buildAuditLog_(report) {
  var lines = [
    '============================================================',
    'UPSERT-BASED MONTHLY GENERATION AUDIT LOG',
    'Source Month (M-1): ' + report.meta.srcStr +
        ' | Target Month (Merge): ' + report.meta.tgtStr,
    '============================================================'
  ];

  for (var s = 0; s < GENERATION_SHEETS.length; s++) {
    var name = GENERATION_SHEETS[s];
    var block = report.sheets[name];
    if (!block) continue;

    lines.push('');
    lines.push(name);
    lines.push('-'.repeat(name.length));
    lines.push('  Updated Rows: ' + block.updated);
    lines.push('  Inserted Rows: ' + block.inserted);
    lines.push('  Details:');

    if (block.appended.length === 0) {
      lines.push('    None');
    } else {
      for (var i = 0; i < block.appended.length; i++) {
        var item = block.appended[i];
        lines.push('    ' + (i + 1) + '. ' + item.list + ' - ' + item.type +
            ' - ' + item.amountFormatted);
      }
    }
  }

  lines.push('');
  lines.push('============================================================');
  return lines.join('\n');
}

/**
 * Summarises a payload for logging without recording any monetary amounts.
 * @param {Object} formData Raw configuration from the dialog.
 * @return {string} Counts only.
 */
function describeSelections_(formData) {
  return 'selected saving=' + countOf_(formData.selectedSaving) +
      ' expense=' + countOf_(formData.selectedExpense) +
      ' ibadah=' + countOf_(formData.selectedIbadah) +
      ' autodeduct=' + countOf_(formData.selectedAutodeduct) +
      ' amountOverrides=' + keyCountOf_(formData.amountOverrides);
}

/**
 * @param {*} list Possibly undefined array.
 * @return {number} Its length, or 0.
 */
function countOf_(list) {
  return (list && list.length) ? list.length : 0;
}

/**
 * @param {*} map Possibly undefined object.
 * @return {number} Its own-property count, or 0.
 */
function keyCountOf_(map) {
  if (!map || typeof map !== 'object') return 0;
  return Object.keys(map).length;
}
