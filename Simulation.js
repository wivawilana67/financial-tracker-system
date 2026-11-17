/**
 * Simulation.js — "Simulate Monthly Budget": a read-only what-if for one month.
 *
 * Flow
 *   runMonthlySimulation()     opens SimulationDialog.html
 *   getSimulationPayload()     the month's baseline, read in one round trip
 *
 * Nothing here writes to a sheet. Every toggle, override and added item lives in
 * the dialog only and is gone when it closes.
 *
 * Baseline, per ledger sheet (hybrid):
 *   - the sheet already has rows dated in the month  -> those rows ("existing")
 *   - it has none yet                                -> what Generate Monthly
 *     would roll over from M-1 ("projected"), via collectRolloverCandidates_
 * Income follows the same rule: the month's own rows, else M-1's.
 *
 * Jajan is not a plain row. The Expense `Jajan` rows hold each person's *net*
 * budget (gross share − autodeductions), so the dialog pulls them out and
 * recalculates them live. The money that leaves is net Jajan + Autodeduct, which
 * is why both are counted as outflow and nothing is counted twice.
 */

/** Defaults when the month has no Jajan rows to infer the real rates from. */
var SIMULATION_DEFAULT_POOL_RATE = 10;
var SIMULATION_DEFAULT_SPLIT_RATE = 50;

/**
 * Opens the simulation dialog on the current month.
 */
function runMonthlySimulation() {
  var context = 'runMonthlySimulation';
  try {
    var template = HtmlService.createTemplateFromFile('SimulationDialog');
    template.defaultMonthLiteral = JSON.stringify(currentMonthKey());

    var html = template.evaluate()
        .setWidth(DIALOG_WIDTH)
        .setHeight(DIALOG_HEIGHT)
        .setTitle('Monthly Simulation');
    SpreadsheetApp.getUi().showModalDialog(html, 'Simulate Monthly Budget (dry run)');
    logInfo(context, 'Simulation dialog opened on ' + currentMonthKey());
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Loads the baseline for one month. Read-only.
 * @param {number} monthIndex 0-based month index.
 * @param {number} year Full year.
 * @return {Object} Income, per-sheet items, Jajan baseline and option lists.
 */
function getSimulationPayload(monthIndex, year) {
  var context = 'getSimulationPayload';
  logInfo(context, 'monthIndex=' + monthIndex + ' year=' + year);
  try {
    var period = resolvePeriod_(monthIndex, year);
    var master = readMasterLists_();
    var ss = getBook_();

    var sections = {};
    var jajanRows = null;
    TARGET_EDIT_SHEETS.forEach(function (sheetName) {
      var sheet = ss.getSheetByName(sheetName);
      var snapshot = sheet ? readLedgerSnapshot_(sheet) : { name: sheetName, values: [] };
      var section = loadSimulationSection_(snapshot, period);
      if (sheetName === 'Expense') jajanRows = section.jajan;
      delete section.jajan;
      sections[sheetName] = section;
    });

    var income = loadSimulationIncome_(ss, period);
    var payload = {
      targetMonth: period.targetDateStr,
      sourceMonth: period.sourceDateStr,
      categories: master.incomeCategories,
      persons: INCOME_PERSONS,
      typeOptions: {
        'Saving': master.savingTypes,
        'Expense': master.expenseTypes,
        'Ibadah': master.ibadahTypes,
        'Autodeduct Jajan': JAJAN_OWNERS
      },
      income: income,
      sections: sections,
      jajan: buildJajanBaseline_(jajanRows, income, sections['Autodeduct Jajan'])
    };

    logInfo(context, 'target=' + period.targetDateStr +
        ' income=' + income.source +
        ' saving=' + sections['Saving'].source + '/' + sections['Saving'].items.length +
        ' expense=' + sections['Expense'].source + '/' + sections['Expense'].items.length +
        ' ibadah=' + sections['Ibadah'].source + '/' + sections['Ibadah'].items.length +
        ' autodeduct=' + sections['Autodeduct Jajan'].source + '/' + sections['Autodeduct Jajan'].items.length +
        ' jajan=' + payload.jajan.source);
    return payload;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * One ledger's baseline items: the month's own rows when it has any, else the
 * M-1 rollover projection. Expense Jajan rows are split out either way.
 * @param {Object} snapshot From readLedgerSnapshot_ (values may be empty).
 * @param {{targetDateStr: string, sourceDateStr: string}} period Resolved period.
 * @return {{source: string, items: Array<Object>, jajan: Array<Array<*>>}} Section.
 */
function loadSimulationSection_(snapshot, period) {
  var C = LEDGER_COLUMNS;
  var sheetName = snapshot.name;
  var values = snapshot.values || [];
  var isExpense = sheetName === 'Expense';

  var items = [];
  var jajan = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (formatDateToYMD(row[C.DATE]) !== period.targetDateStr) continue;
    if (isExpense && isJajanRow_(row[C.TYPE])) {
      jajan.push(row);
      continue;
    }
    items.push(simulationItem_(sheetName, 'r' + (r + 1), row[C.LIST], row[C.TYPE],
        row[C.AMOUNT], row[C.CHANNEL], isCheckedCell_(row[C.IS_CICILAN]), row[C.REMAINING]));
  }
  if (items.length || jajan.length) return { source: 'existing', items: items, jajan: jajan };

  // Nothing in the month yet: project the rollover. Installments land with one
  // payment fewer, exactly as Generate would write them.
  var candidates = values.length > 1 ? collectRolloverCandidates_(snapshot, period) : [];
  candidates.forEach(function (c, i) {
    items.push(simulationItem_(sheetName, 'p' + i, c.list, c.whoType, c.amount, c.noteChannel,
        c.isCicilan, c.isCicilan ? c.remainingMonth - 1 : ''));
  });
  return { source: 'projected', items: items, jajan: [] };
}

/**
 * @return {Object} Plain item the dialog renders.
 */
function simulationItem_(sheetName, id, list, type, amount, channel, isCicilan, remaining) {
  var value = typeof amount === 'number' && isFinite(amount) ? amount : 0;
  var left = parseInt(remaining, 10);
  return {
    id: sheetName + ':' + id,
    list: orPlaceholder_(list),
    type: orPlaceholder_(type),
    channel: channel ? String(channel) : '',
    amount: value,
    isCicilan: !!isCicilan,
    remaining: isCicilan && !isNaN(left) ? left : null,
    owner: sheetName === 'Autodeduct Jajan' ? normaliseJajanOwner_(type) : ''
  };
}

/**
 * Income per person and category: the month's own rows, else M-1's.
 * @param {Spreadsheet} ss Active spreadsheet.
 * @param {{targetDateStr: string, sourceDateStr: string}} period Resolved period.
 * @return {{source: string, month: string, amounts: Object}} {person: {category: amount}}.
 */
function loadSimulationIncome_(ss, period) {
  // loadIncomeDefaults_ reads whichever month sits in `sourceDateStr`.
  var own = loadIncomeDefaults_(ss, { sourceDateStr: period.targetDateStr });
  if (hasAnyIncome_(own)) return { source: 'existing', month: period.targetDateStr, amounts: own };
  return { source: 'projected', month: period.sourceDateStr,
      amounts: loadIncomeDefaults_(ss, period) };
}

/** @return {boolean} True when any person has any income figure. */
function hasAnyIncome_(amounts) {
  return INCOME_PERSONS.some(function (person) {
    return Object.keys(amounts[person] || {}).length > 0;
  });
}

/**
 * Baseline Jajan per person, plus the rates the dialog starts from.
 *
 * When the month already has Jajan rows, their net figures are the baseline and
 * the pool rate and split are inferred from them (gross = net + autodeduct), so
 * an untouched simulation reproduces the sheet exactly and only real changes
 * move it. A clamped (zero) net hides the true gross, so then — and when there
 * are no Jajan rows — the Generate dialog's defaults are used instead.
 *
 * @param {Array<Array<*>>} jajanRows Expense Jajan rows dated in the month.
 * @param {Object} income From loadSimulationIncome_.
 * @param {{items: Array<Object>}} autodeduct Autodeduct section.
 * @return {Object} {source, net: {Wiva, Jane}|null, poolRate, wivaRate, janeRate}.
 */
function buildJajanBaseline_(jajanRows, income, autodeduct) {
  var C = LEDGER_COLUMNS;
  var result = { source: 'calculated', net: null, poolRate: SIMULATION_DEFAULT_POOL_RATE,
      wivaRate: SIMULATION_DEFAULT_SPLIT_RATE, janeRate: SIMULATION_DEFAULT_SPLIT_RATE };
  if (!jajanRows || !jajanRows.length) return result;

  var net = { Wiva: 0, Jane: 0 };
  jajanRows.forEach(function (row) {
    var owner = normaliseJajanOwner_(row[C.LIST]);
    var amount = Number(row[C.AMOUNT]);
    if (owner && isFinite(amount)) net[owner] += amount;
  });
  result.source = 'existing';
  result.net = net;

  var auto = { Wiva: 0, Jane: 0 };
  autodeduct.items.forEach(function (item) {
    if (item.owner) auto[item.owner] += item.amount;
  });

  var base = 0;
  INCOME_PERSONS.forEach(function (person) {
    var amounts = income.amounts[person] || {};
    for (var category in amounts) {
      if (category.trim().toLowerCase() === DEFAULT_JAJAN_INCOME_CATEGORY.toLowerCase()) {
        base += amounts[category];
      }
    }
  });

  var wivaGross = net.Wiva + auto.Wiva;
  var janeGross = net.Jane + auto.Jane;
  if (base > 0 && net.Wiva > 0 && net.Jane > 0) {
    result.poolRate = roundRate_((wivaGross + janeGross) / base * 100);
    result.wivaRate = roundRate_(wivaGross / (wivaGross + janeGross) * 100);
    result.janeRate = roundRate_(100 - result.wivaRate);
  }
  return result;
}

/** @return {number} Percentage rounded to 2 decimals. */
function roundRate_(value) {
  return Math.round(value * 100) / 100;
}
