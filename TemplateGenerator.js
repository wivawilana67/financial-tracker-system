/**
 * TemplateGenerator.js — builds the blank Financial Plan workbook in any spreadsheet.
 *
 * Recreates every tab's structure: headers, formulas, merged cells, checkboxes,
 * dropdown validation, conditional formatting, frozen panes and number formats.
 * It writes no transaction data, but it does fill the Master option lists, so the
 * dropdowns work straight away.
 *
 * Safe to re-run: a tab that already holds anything is skipped and left
 * untouched; only missing (or completely empty) tabs are built. To refresh a tab
 * on purpose, rebuild it: its contents are erased. Backing a tab up first (a copy
 * inside the same spreadsheet) is a separate, per-tab choice. Every tab is treated
 * the same, data tabs included.
 *
 * Entry points:
 *   runGenerateTemplate()                       menu: build missing tabs
 *   runRebuildTemplateTabs()                    menu: pick tabs to rebuild
 *   generateFinancialTemplate(idOrUrl, opts)    programmatic, '' = active spreadsheet
 *   rebuildTemplateTabs(rebuild, backup, idOrUrl)   what the rebuild dialog calls
 */

/** Last row that carries checkboxes / dropdowns on each ledger sheet. */
var TEMPLATE_LEDGER_LAST_ROW = 1000;
/** Grid widths (columns) of tabs whose builder does not imply one. */
var TEMPLATE_LEDGER_COLS = 27;    // A..AA
var TEMPLATE_MASTER_SIZE = [1000, 26];
var TEMPLATE_CC_TRANSACTION_SIZE = [1000, 7];
/** Last row of the Blu Balance transaction table. */
var TEMPLATE_BLU_LAST_ROW = 1021;
/** Last row of the CC Tracker table. */
var TEMPLATE_BCA_LAST_ROW = 480;
/** Dashboard grid size. */
var TEMPLATE_DASH_ROWS = 86;
var TEMPLATE_DASH_COLS = 28;
/** Last row of the Dashboard per-row checklist (checkboxes in AB8:AB68). */
var TEMPLATE_DASH_LIST_LAST_ROW = 68;

var TEMPLATE_COLORS = {
  CHECK_GREEN: '#b7e1cd',
  GREEN: '#d9ead3',
  RED: '#f4cccc',
  PURE_RED: '#ff0000',
  BLUE: '#c9daf8',
  BCA_GREEN: '#d8edd3',
  BCA_ORANGE: '#fcedcc',
  TAB_GREEN: '#00ff00'
};

/** Final tab order of the workbook. */
var TEMPLATE_SHEET_ORDER = [
  'Blu Balance', 'CC Tracker', 'CC Transaction', 'Finance ->', 'Dashboard', 'Income',
  'Saving', 'Expense', 'Ibadah', 'Autodeduct Jajan', 'Master'
];

/* ==========================================================================
 * Entry points
 * ========================================================================== */

/**
 * Menu handler: asks where to build the template, then builds it.
 * Accepts a spreadsheet URL or ID; blank means the current spreadsheet.
 */
function runGenerateTemplate() {
  var context = 'runGenerateTemplate';
  var ui = SpreadsheetApp.getUi();
  try {
    var answer = ui.prompt(
        'Generate Template',
        'Paste the URL or ID of the spreadsheet to build the template in.\n' +
        'Leave blank to use this spreadsheet. Tabs that already hold data are skipped.',
        ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;

    var report = generateFinancialTemplate(answer.getResponseText());
    ui.alert('Template generated',
        'Created: ' + (report.created.join(', ') || 'nothing') + '\n\n' +
        'Skipped (already in use): ' + (report.skipped.join(', ') || 'none') + '\n\n' +
        'Spreadsheet: ' + report.url,
        ui.ButtonSet.OK);
  } catch (e) {
    logError(context, e);
    ui.alert('Generate Template failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

/**
 * Builds every missing template tab in the target spreadsheet.
 * @param {string=} idOrUrl Spreadsheet ID or URL; empty = active spreadsheet.
 * @param {{rebuild: Array<string>, backup: Array<string>}=} options Tab names to erase
 *     and rebuild instead of skipping, and which of those to copy first.
 * @return {{created: Array<string>, skipped: Array<string>, rebuilt: Array<string>,
 *           backups: Array<string>, url: string}}
 */
function generateFinancialTemplate(idOrUrl, options) {
  var context = 'generateFinancialTemplate';
  logInfo(context, 'Target: ' + (idOrUrl ? parseSpreadsheetId_(idOrUrl) : 'active spreadsheet'));
  try {
    var ss = openTemplateTarget_(idOrUrl);
    var rebuild = (options && options.rebuild) || [];
    var backup = (options && options.backup) || [];
    var report = {created: [], skipped: [], rebuilt: [], backups: [], url: ss.getUrl()};

    // Master first: the ledgers' dropdowns point at its ranges.
    var builders = [
      ['Master', buildMasterSheet_],
      ['Income', buildIncomeSheet_],
      ['Saving', buildSavingSheet_],
      ['Expense', buildExpenseSheet_],
      ['Ibadah', buildIbadahSheet_],
      ['Autodeduct Jajan', buildAutodeductSheet_],
      ['Dashboard', buildDashboardSheet_],
      ['Finance ->', buildDividerSheet_],
      ['CC Tracker', buildBcaTrackerSheet_],
      ['CC Transaction', buildCcTransactionSheet_],
      ['Blu Balance', buildBluBalanceSheet_]
    ];

    builders.forEach(function(entry) {
      var name = entry[0];
      var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      var rebuilding = false;
      if (!isSheetEmpty_(sheet)) {
        if (rebuild.indexOf(name) === -1) {
          report.skipped.push(name);
          logInfo(context, 'Skipped "' + name + '": already has content.');
          return;
        }
        if (backup.indexOf(name) !== -1) report.backups.push(backupTemplateSheet_(ss, sheet));
        resetTemplateSheet_(sheet);
        rebuilding = true;
      }
      try {
        entry[1](ss, sheet);
        applyTemplateStyles_(sheet);
        (rebuilding ? report.rebuilt : report.created).push(name);
        logInfo(context, 'Built "' + name + '".');
      } catch (e) {
        logError(context + ' > ' + name, e);
        throw e;
      }
    });

    finishTemplate_(ss);
    SpreadsheetApp.flush();
    return report;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Menu handler: shows a checklist of the template tabs and rebuilds the ticked
 * ones in the current spreadsheet. Each is backed up first, then erased.
 */
function runRebuildTemplateTabs() {
  var context = 'runRebuildTemplateTabs';
  try {
    var html = HtmlService.createHtmlOutput(buildRebuildDialogHtml_(TEMPLATE_SHEET_ORDER))
        .setWidth(440)
        .setHeight(520);
    SpreadsheetApp.getUi().showModalDialog(html, 'Rebuild Template Tabs');
    logInfo(context, 'Opened rebuild dialog.');
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/**
 * Called by the rebuild dialog. Names are checked against the template's own
 * tab list, so nothing else in the workbook can be targeted.
 * @param {Array<string>} rebuildNames Tabs to erase and rebuild.
 * @param {Array<string>} backupNames Tabs to copy first; only those also being rebuilt count.
 * @param {string=} idOrUrl Target spreadsheet; empty = active spreadsheet.
 * @return {{created: Array<string>, rebuilt: Array<string>, backups: Array<string>}}
 */
function rebuildTemplateTabs(rebuildNames, backupNames, idOrUrl) {
  var context = 'rebuildTemplateTabs';
  logInfo(context, 'Rebuild: ' + JSON.stringify(rebuildNames) +
      ', backup: ' + JSON.stringify(backupNames));
  try {
    var known = function(name) { return TEMPLATE_SHEET_ORDER.indexOf(name) !== -1; };
    var rebuild = (rebuildNames || []).filter(known);
    if (!rebuild.length) throw new Error('Pick at least one tab to rebuild.');
    var backup = (backupNames || []).filter(function(name) {
      return known(name) && rebuild.indexOf(name) !== -1;
    });
    return generateFinancialTemplate(idOrUrl, {rebuild: rebuild, backup: backup});
  } catch (e) {
    logError(context, e);
    throw e;
  }
}

/** Dialog markup: a Rebuild and a Backup checkbox per tab, a confirm step, a result line. */
function buildRebuildDialogHtml_(names) {
  var style = [
    'body { font: 14px Arial, sans-serif; margin: 16px; }',
    'table { border-collapse: collapse; width: 100%; }',
    'th, td { padding: 5px 8px; text-align: center; }',
    'th:first-child, td:first-child { text-align: left; }',
    'thead th { border-bottom: 1px solid #ccc; font-size: 13px; }',
    '.warn { background: #fef3c7; border-radius: 6px; padding: 8px; margin: 0 0 10px; font-size: 13px; }',
    'button { padding: 8px 14px; margin-right: 8px; }',
    '#msg { margin-top: 12px; font-size: 13px; }'
  ].join('\n');

  var body = [
    '<div class="warn">Rebuilt tabs are <b>erased</b>. Tick <b>Backup</b> to save a copy ',
    'of a tab in this spreadsheet first; without it the old contents are gone.</div>',
    '<table><thead><tr><th>Tab</th>',
    '<th>Rebuild<br><input type="checkbox" id="allRebuild"></th>',
    '<th>Backup<br><input type="checkbox" id="allBackup"></th></tr></thead>',
    '<tbody id="rows"></tbody></table>',
    '<p><button id="go">Rebuild selected</button><button id="cancel">Cancel</button></p>',
    '<div id="msg"></div>'
  ].join('\n');

  var script = [
    'var names = ' + JSON.stringify(names) + ';',
    'var rows = document.getElementById("rows");',
    'var msg = document.getElementById("msg");',
    'var go = document.getElementById("go");',
    'function box(cls, i) {',
    '  var cell = document.createElement("td");',
    '  var input = document.createElement("input");',
    '  input.type = "checkbox"; input.className = cls; input.value = i;',
    '  cell.appendChild(input);',
    '  return cell;',
    '}',
    'names.forEach(function(name, i) {',
    '  var row = document.createElement("tr");',
    '  var label = document.createElement("td");',
    '  label.textContent = name;',
    '  row.appendChild(label);',
    '  row.appendChild(box("rebuild", i));',
    '  row.appendChild(box("backup", i));',
    '  rows.appendChild(row);',
    '});',
    'function all(cls) { return [].slice.call(document.querySelectorAll("." + cls)); }',
    'function ticked(cls) { return all(cls).filter(function(b) { return b.checked; }); }',
    'function namesOf(boxes) { return boxes.map(function(b) { return names[b.value]; }); }',
    'function link(masterId, cls) {',
    '  document.getElementById(masterId).onchange = function() {',
    '    var checked = this.checked;',
    '    all(cls).forEach(function(b) { b.checked = checked; });',
    '  };',
    '}',
    'link("allRebuild", "rebuild");',
    'link("allBackup", "backup");',
    'document.getElementById("cancel").onclick = function() { google.script.host.close(); };',
    'go.onclick = function() {',
    '  var rebuild = namesOf(ticked("rebuild"));',
    '  var backup = namesOf(ticked("backup")).filter(function(n) { return rebuild.indexOf(n) !== -1; });',
    '  if (!rebuild.length) { msg.textContent = "Tick at least one tab to rebuild."; return; }',
    '  var unsaved = rebuild.filter(function(n) { return backup.indexOf(n) === -1; });',
    '  var question = "Erase and rebuild: " + rebuild.join(", ") + "?";',
    '  question += unsaved.length ? "\\nNo backup for: " + unsaved.join(", ") : "\\nAll will be backed up first.";',
    '  if (!confirm(question)) return;',
    '  go.disabled = true;',
    '  msg.textContent = "Rebuilding... this can take a minute.";',
    '  google.script.run',
    '      .withSuccessHandler(function(r) {',
    '        msg.textContent = "Rebuilt: " + r.rebuilt.concat(r.created).join(", ") +',
    '            ". Backups: " + (r.backups.join(", ") || "none");',
    '        go.disabled = false;',
    '      })',
    '      .withFailureHandler(function(e) { msg.textContent = "Failed: " + e.message; go.disabled = false; })',
    '      .rebuildTemplateTabs(rebuild, backup);',
    '};'
  ].join('\n');

  return '<style>' + style + '</style>' + body + '<script>' + script + '</script>';
}

/* ==========================================================================
 * Workbook-level helpers
 * ========================================================================== */

/** Extracts the spreadsheet ID from a URL, or returns the trimmed input. */
function parseSpreadsheetId_(idOrUrl) {
  var text = String(idOrUrl || '').trim();
  var match = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : text;
}

function openTemplateTarget_(idOrUrl) {
  var id = parseSpreadsheetId_(idOrUrl);
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet available. Pass a spreadsheet ID or URL.');
  return ss;
}

/** True for a sheet nobody has written to (a fresh insertSheet or default tab). */
function isSheetEmpty_(sheet) {
  return sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
}

/** Orders the tabs, hides Master and drops the blank default "Sheet1". */
function finishTemplate_(ss) {
  TEMPLATE_SHEET_ORDER.forEach(function(name, index) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(index + 1);
  });

  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && isSheetEmpty_(defaultSheet) && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  var master = ss.getSheetByName('Master');
  if (master && !master.isSheetHidden()) master.hideSheet();

  var dashboard = ss.getSheetByName('Dashboard');
  if (dashboard) ss.setActiveSheet(dashboard);
}

/**
 * Copies a tab inside the same spreadsheet before it is erased.
 * @return {string} The backup tab's name.
 */
function backupTemplateSheet_(ss, sheet) {
  var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH.mm.ss');
  var copy = sheet.copyTo(ss);
  copy.setName(sheet.getName() + ' (backup ' + stamp + ')');
  logInfo('backupTemplateSheet_', 'Backed up "' + sheet.getName() + '" as "' + copy.getName() + '".');
  return copy.getName();
}

/**
 * Clears a tab in place. It is not deleted: other tabs' formulas point at it,
 * and a deleted sheet would leave them as permanent #REF! errors.
 */
function resetTemplateSheet_(sheet) {
  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();
  var all = sheet.getRange(1, 1, maxRows, maxCols);
  all.breakApart();
  all.clear();
  all.clearDataValidations();
  all.clearNote();
  sheet.setConditionalFormatRules([]);
  sheet.setFrozenRows(0);
  sheet.setFrozenColumns(0);
  sheet.setColumnWidths(1, maxCols, 100);
  sheet.setRowHeights(1, maxRows, 21);
  sheet.setHiddenGridlines(false);
  sheet.setTabColor(null);
}

/**
 * Sizes the grid to exactly rows x cols, as on the source workbook: grows it
 * (getRange throws past the grid) or trims the default 1000 x 26 down.
 */
function fitTemplateSize_(sheet, rows, cols) {
  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();
  if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
  if (maxRows > rows) sheet.deleteRows(rows + 1, maxRows - rows);
  if (maxCols < cols) sheet.insertColumnsAfter(maxCols, cols - maxCols);
  if (maxCols > cols) sheet.deleteColumns(cols + 1, maxCols - cols);
}

/* ==========================================================================
 * Cell helpers
 * ========================================================================== */

/**
 * Writes a 2D block at a top-left cell in one call. Strings starting with '='
 * become formulas; '' leaves the cell blank.
 */
function putBlock_(sheet, topLeft, rows) {
  var width = rows.reduce(function(max, row) { return Math.max(max, row.length); }, 0);
  var padded = rows.map(function(row) {
    var copy = row.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
  sheet.getRange(topLeft).offset(0, 0, padded.length, width).setValues(padded);
}

/** Writes one formula or value at a single cell. */
function putCell_(sheet, a1, value) {
  sheet.getRange(a1).setValue(value);
}

/** Repeats the source cell's formula (relative refs shift) over the target range. */
function fillFormula_(sheet, sourceA1, targetA1) {
  sheet.getRange(sourceA1).copyTo(
      sheet.getRange(targetA1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
}

function mergeCells_(sheet, a1) {
  sheet.getRange(a1).merge();
}

function insertCheckboxes_(sheet, a1) {
  sheet.getRange(a1).insertCheckboxes();
}

/** Strict dropdown fed by a range such as 'Master!$C$3:$C$1000'. */
function setRangeDropdown_(ss, sheet, targetA1, sourceA1) {
  var rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(ss.getRange(sourceA1), true)
      .setAllowInvalid(false)
      .build();
  sheet.getRange(targetA1).setDataValidation(rule);
}

/** Strict dropdown fed by a fixed list. */
function setListDropdown_(sheet, targetA1, values) {
  var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(values, true)
      .setAllowInvalid(false)
      .build();
  sheet.getRange(targetA1).setDataValidation(rule);
}

/** Appends conditional-format rules, keeping their order (earlier rules win). */
function addFormatRules_(sheet, rules) {
  sheet.setConditionalFormatRules(sheet.getConditionalFormatRules().concat(rules));
}

/** Conditional rule on a custom formula. */
function formulaRule_(sheet, a1, formula, background, bold) {
  var builder = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(formula)
      .setBackground(background)
      .setRanges([sheet.getRange(a1)]);
  if (bold) builder.setBold(true);
  return builder.build();
}

/* ==========================================================================
 * Master + ledgers
 * ========================================================================== */

function buildMasterSheet_(ss, sheet) {
  fitTemplateSize_(sheet, TEMPLATE_MASTER_SIZE[0], TEMPLATE_MASTER_SIZE[1]);
  // Option lists: one column per ledger, plus the payment channels in I.
  var columns = {
    A: ['Income', 'Type', 'Salary', 'Business', 'Bonus', 'Transfer Addition'],
    C: ['Saving', 'Type', 'Dana Darurat', 'Savings', 'Crypto', 'Pension'],
    E: ['Expense', 'Type', 'Kebutuhan', 'Keinginan', 'Hutang', 'Investasi', 'Tidak Terduga', 'Jajan'],
    G: ['Ibadah', 'Type', 'Persepuluhan', 'Donasi', 'Orang Tua'],
    I: ['Payment Channel', 'Type', 'CC BCA', 'CC Tokopedia', 'CC HSBC', 'CC Mandiri Rio',
        'BCA Debit Rio', 'BCA Expressi Rio', 'Blu Rio', 'GoPay Rio', 'CC Mandiri Jane',
        'BCA Debit Jane', 'BCA Expressi Jane', 'Blu Jane', 'GoPay Jane', 'Cash']
  };
  Object.keys(columns).forEach(function(col) {
    putBlock_(sheet, col + '1', columns[col].map(function(value) { return [value]; }));
  });
  sheet.setFrozenRows(2);
}

/**
 * Shared ledger layout: header row, frozen header + first column, date and
 * amount formats, Cicilan?/Sudah Bayar? checkboxes and the channel dropdown.
 */
function buildLedgerSheet_(ss, sheet, headers, typeDropdown) {
  var last = TEMPLATE_LEDGER_LAST_ROW;
  fitTemplateSize_(sheet, last, TEMPLATE_LEDGER_COLS);
  putBlock_(sheet, 'A1', [headers]);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);


  if (typeDropdown.list) {
    setListDropdown_(sheet, 'C2:C' + last, typeDropdown.list);
  } else {
    setRangeDropdown_(ss, sheet, 'C2:C' + last, typeDropdown.range);
  }

  if (headers.length > 4) {
    setRangeDropdown_(ss, sheet, 'E2:E' + last, 'Master!$I$3:$I$1000');
    insertCheckboxes_(sheet, 'F2:F' + last);
    insertCheckboxes_(sheet, 'H2:H' + last);
  }
}

var TEMPLATE_LEDGER_HEADERS = ['Month', 'List', 'Type', 'Amount', 'Payment Channel',
                               'Cicilan?', 'Payment Remaining', 'Sudah Bayar?'];

/** Income's Type is a fixed list (it mirrors Master A3:A6, but is not linked to it). */
function buildIncomeSheet_(ss, sheet) {
  buildLedgerSheet_(ss, sheet, ['Month', 'List', 'Type', 'Amount'],
      {list: ['Salary', 'Business', 'Bonus', 'Transfer Addition']});
}

function buildSavingSheet_(ss, sheet) {
  buildLedgerSheet_(ss, sheet, TEMPLATE_LEDGER_HEADERS, {range: 'Master!$C$3:$C$1000'});
}

function buildExpenseSheet_(ss, sheet) {
  buildLedgerSheet_(ss, sheet, TEMPLATE_LEDGER_HEADERS, {range: 'Master!$E$3:$E$1000'});
}

function buildIbadahSheet_(ss, sheet) {
  buildLedgerSheet_(ss, sheet, TEMPLATE_LEDGER_HEADERS, {range: 'Master!$G$3:$G$1000'});
}

function buildAutodeductSheet_(ss, sheet) {
  var headers = TEMPLATE_LEDGER_HEADERS.slice();
  headers[2] = 'Who?';
  buildLedgerSheet_(ss, sheet, headers, {list: ['Wiva', 'Jane']});
}

/* ==========================================================================
 * Divider
 * ========================================================================== */

function buildDividerSheet_(ss, sheet) {
  fitTemplateSize_(sheet, 1, 1);
  sheet.setTabColor(TEMPLATE_COLORS.TAB_GREEN);
}

/* ==========================================================================
 * CC Tracker (CC Transaction is built by buildCcTransactionSheet_ in CcSync.js)
 * ========================================================================== */

function buildBcaTrackerSheet_(ss, sheet) {
  var last = TEMPLATE_BCA_LAST_ROW;
  fitTemplateSize_(sheet, last, 11);

  // F = Amount, H = Select, I = Paid, J = Cancelled (see CC_TRACKER_COLS in CcSync.js).
  putBlock_(sheet, 'A1', [
    ['Current Week', '=TODAY()-WEEKDAY(TODAY(), 2)+1', '=TODAY()-WEEKDAY(TODAY(), 2)+7'],
    ['Total Paid', '=SUMIFS($F$8:$F, $I$8:$I, TRUE, $J$8:$J, FALSE)'],
    ['Outstanding Balance', '=SUMIFS($F$8:$F, $I$8:$I, FALSE, $J$8:$J, FALSE)'],
    ['Total Amount', '=SUMIFS($F$8:$F, $J$8:$J, FALSE)'],
    ['Total Selected Amount', '=SUMIFS($F$8:$F, $H$8:$H, TRUE, $J$8:$J, FALSE)', 'Bagi 2', '=B5/2']
  ]);

  putBlock_(sheet, 'A7', [[
    'Datetime', 'Bank', 'Card Number', 'Description', 'Type', 'Amount', 'Currency Code',
    'Select', 'Paid', 'Cicilan / Bulanan', 'Note'
  ]]);

  // The CC sync writes A:G directly (CC_TRACKER_START_COL in CcSync.js).
  insertCheckboxes_(sheet, 'H8:J' + last);


  sheet.setFrozenRows(7);
  sheet.setFrozenColumns(5);

  // Fill colours cover the whole row A:K, Note included. restoreCcTrackerRows_
  // (CcSync.js) keeps this range in step as rows are deleted and appended.
  var range = 'A8:K' + last;
  addFormatRules_(sheet, [
    formulaRule_(sheet, range, '=$J8=TRUE', TEMPLATE_COLORS.RED),
    formulaRule_(sheet, range, '=$I8=TRUE', TEMPLATE_COLORS.BCA_GREEN),
    formulaRule_(sheet, range, '=AND($H8=TRUE, $I8=FALSE)', TEMPLATE_COLORS.BCA_ORANGE)
  ]);
}

/* ==========================================================================
 * Blu Balance
 * ========================================================================== */

function buildBluBalanceSheet_(ss, sheet) {
  var last = TEMPLATE_BLU_LAST_ROW;
  fitTemplateSize_(sheet, last, 36);

  putBlock_(sheet, 'A1', [
    ['Total Wallet', '=SUMIFS($C$16:$C,$E$16:$E, TRUE)', 'Sisa Cicilan'],
    ['Sisa Uang skrg + Sisa Cicilan', '=$B1-SUMIFS($C$16:$C,$E$16:$E,FALSE,$F$16:$F,TRUE) + C2',
     '=SUMIFS($C$16:$C,$G$16:$G,"Cicil",$F$16:$F, TRUE)-SUM($J$16:$J)'],
    ['Sisa Seharusnya', '=$B1-SUMIFS($C$16:$C,$E$16:$E,FALSE)']
  ]);
  putBlock_(sheet, 'A5', [['Account', 'Remaining']]);

  // One "remaining" formula per account row; the account names are yours to fill in.
  putCell_(sheet, 'B6',
      '=SUMIFS($C$16:$C,$E$16:$E,TRUE, $F$16:$F, TRUE, $D$16:$D,$A6)' +
      ' - SUMIFS($C$16:$C,$E$16:$E,FALSE, $F$16:$F, TRUE, $D$16:$D,$A6)' +
      ' + SUMIFS($C$16:$C,$G$16:$G,"Cicil", $F$16:$F, TRUE, $D$16:$D,$A6)' +
      ' - SUMIFS($J$16:$J,$D$16:$D,$A6)');
  fillFormula_(sheet, 'B6', 'B7:B12');
  putBlock_(sheet, 'A13', [['Checker Diff', '=$B2-SUM($B6:$B12)', '=$B2=SUM($B6:$B12)']]);

  var headers = ['Date', 'List Usage', 'Price', 'Account', 'Income?', 'Sudah Bayar?',
                 'Cicil / Not', 'Bulan', 'Sisa Bulan', 'Sudah Bayar Cicilan',
                 'Cicilan per Bulan', 'Bayar ke?'];
  putBlock_(sheet, 'A15', [headers]);
  // Instalment counter 1..24 across M:AJ (the last column).
  putCell_(sheet, 'M15', 1);
  putCell_(sheet, 'N15', '=M15+1');
  fillFormula_(sheet, 'N15', 'O15:AJ15');

  putBlock_(sheet, 'I16', [[
    '=IF($H16="","",$H16-COUNTIFS($M16:$AJ16,TRUE))',
    '=IF(REGEXMATCH(G16,"Cicil"),(C16/H16)*COUNTIFS($M16:$AJ16,TRUE),"")',
    '=IFERROR(C16/H16)'
  ]]);
  fillFormula_(sheet, 'I16:K16', 'I17:K' + last);

  setRangeDropdown_(ss, sheet, 'D16:D' + last, "'Blu Balance'!$A$6:$A$12");
  setListDropdown_(sheet, 'G16:G' + last, ['Cicil']);
  insertCheckboxes_(sheet, 'E16:F' + last);
  insertCheckboxes_(sheet, 'M16:AJ' + last);

  // Formatting
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(15);

  addFormatRules_(sheet, [
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(0)
        .setBackground(TEMPLATE_COLORS.GREEN).setBold(true)
        .setRanges([sheet.getRange('B3')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
        .setBackground(TEMPLATE_COLORS.RED).setBold(true)
        .setRanges([sheet.getRange('B3')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('TRUE')
        .setBackground(TEMPLATE_COLORS.CHECK_GREEN)
        .setRanges([sheet.getRange('B13:C13')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('FALSE')
        .setBackground(TEMPLATE_COLORS.PURE_RED)
        .setRanges([sheet.getRange('B13:C13')]).build()
  ]);
}

/* ==========================================================================
 * Dashboard
 * ========================================================================== */

/**
 * Dashboard layout (rows are sheet rows):
 *   A4:C14    income + deduction totals     H4:R19   Saving / Expense / Ibadah cards
 *   A17:E34   payment-channel checklist     U4:AB68  List Items + per-row checklist
 *   A38:D48   Jajan summary + detail        A63:F86  Cicilan summary
 * Update Paid Status reads the two checklists (see PAID_STATUS_CONFIG).
 */
function buildDashboardSheet_(ss, sheet) {
  fitTemplateSize_(sheet, TEMPLATE_DASH_ROWS, TEMPLATE_DASH_COLS);
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(1);

  buildDashboardIncome_(sheet);
  buildDashboardCards_(sheet);
  buildDashboardChannels_(sheet);
  buildDashboardJajan_(sheet);
  buildDashboardListItems_(sheet);
  buildDashboardCicilan_(sheet);
  buildDashboardFormatRules_(sheet);
}

/** Report month + income block (A1:C14). */
function buildDashboardIncome_(sheet) {
  var now = new Date();
  putBlock_(sheet, 'A1', [['Report Month', new Date(now.getFullYear(), now.getMonth(), 1)]]);

  putCell_(sheet, 'A4', 'Income');
  mergeCells_(sheet, 'A4:A14');

  putBlock_(sheet, 'B4', [
    ['=UNIQUE(Master!A$3:A)',
     '=SUMIFS(Income!$D$2:$D,Income!$A$2:$A,EOMONTH($B$1,-1)+1,Income!$C$2:$C,$B4)']
  ]);
  fillFormula_(sheet, 'C4', 'C5:C7');
  putBlock_(sheet, 'B9', [['Total', '=SUM(C4:C7)']]);
  putBlock_(sheet, 'B10', [['Total Deduction', '=SUM($W$8:$W)']]);
  putBlock_(sheet, 'B11', [['Total Realized Deduction', '=SUMIFS($W$8:$W,$AA$8:$AA,TRUE)']]);
  putBlock_(sheet, 'B13', [['Expected Remaining', '=C$9-C10']]);
  putBlock_(sheet, 'B14', [['Current Remaining', '=C$9-C11']]);
}

/**
 * One card per ledger: Saving (H:J), Expense (L:N), Ibadah (P:R).
 * `col` is the card's first column letter; the % and amount columns follow it.
 */
function buildDashboardCards_(sheet) {
  var cards = [
    {title: 'Saving', col: 'H', amount: 'I', pct: 'J', master: 'C', target: 0.4, lastRow: 15},
    {title: 'Expense', col: 'L', amount: 'M', pct: 'N', master: 'E', target: 0.5, lastRow: 17},
    {title: 'Ibadah', col: 'P', amount: 'Q', pct: 'R', master: 'G', target: 0.1, lastRow: 14}
  ];

  cards.forEach(function(c) {
    var span = c.col + '4:' + c.pct + '5';
    putCell_(sheet, c.col + '4', c.title);
    mergeCells_(sheet, span);

    putBlock_(sheet, c.col + '7', [
      ['Target', '=' + c.pct + '7*$C$9', c.target],
      ['Total', '=SUM(' + c.amount + '12:' + c.amount + '17)'],
      ['Total to Target %', '=' + c.amount + '8/$C$9']
    ]);

    putBlock_(sheet, c.col + '11', [['Category', 'Amount', '%']]);
    putBlock_(sheet, c.col + '12', [[
      '=UNIQUE(Master!' + c.master + '$3:' + c.master + ')',
      '=SUMIFS($W$8:$W,$V$8:$V,' + c.col + '12)',
      '=' + c.amount + '12/' + c.amount + '$8'
    ]]);
    fillFormula_(sheet, c.amount + '12:' + c.pct + '12',
        c.amount + '13:' + c.pct + c.lastRow);

    putBlock_(sheet, c.col + '19', [['List', 'Type', 'Amount']]);

  });

  // Jajan is the last Expense category: it also carries the autodeduct share.
  putCell_(sheet, 'M17',
      '=SUMIFS($W$8:$W,$V$8:$V,L17) + SUMIFS($W$8:$W,$V$8:$V, $A42) + SUMIFS($W$8:$W,$V$8:$V, $A43)');

  // This month's rows per ledger, biggest first.
  var windowMonth = 'EOMONTH($B$1,-1)+1';
  putCell_(sheet, 'H20', '=IFERROR(SORT(FILTER(INDIRECT(H$4&"!B:D"), INDIRECT(H$4&"!A:A")=' +
      windowMonth + '),2,5))');
  putCell_(sheet, 'L20', '=SORT(VSTACK(IFERROR(FILTER(INDIRECT(L$4&"!B:D"), INDIRECT(L$4&"!A:A")=' +
      windowMonth + ')), FILTER(\'Autodeduct Jajan\'!$B$2:$D,\'Autodeduct Jajan\'!$A$2:$A=' +
      windowMonth + ')), 2, 1)');
  putCell_(sheet, 'P20', '=IFERROR(SORT(FILTER(INDIRECT(P$4&"!B:D"), INDIRECT(P$4&"!A:A")=' +
      windowMonth + '),2,5))');
}

/** Payment-channel checklist (A17:E34). Ticking E marks that channel paid. */
function buildDashboardChannels_(sheet) {
  putCell_(sheet, 'A17', 'Payment Channel');
  mergeCells_(sheet, 'A17:E19');

  putBlock_(sheet, 'A20', [
    ['Payment Channel', 'Expected Amount', 'Paid Amount', 'Remaining Amount', 'Paid Automatic?']
  ]);

  putBlock_(sheet, 'A21', [[
    '=UNIQUE(Master!$I$3:$I)',
    '=SUMIFS($W$8:$W,$X$8:$X,$A21)',
    '=SUMIFS($W$8:$W,$X$8:$X,$A21,$AA$8:$AA,TRUE)',
    '=B21-C21'
  ]]);
  fillFormula_(sheet, 'B21:D21', 'B22:D34');
  insertCheckboxes_(sheet, 'E21:E34');
}

/** Jajan summary + detail (A38:D48). Wiva/Jane are the two owners the code recognises. */
function buildDashboardJajan_(sheet) {
  putCell_(sheet, 'A38', 'Jajan Summary');
  mergeCells_(sheet, 'A38:D40');
  putBlock_(sheet, 'A41', [['List', 'Jajan Amount', 'Deduction', 'Final Amount']]);

  putBlock_(sheet, 'A42', [[
    'Wiva',
    '=FILTER($W$8:$W,$V$8:$V="Jajan",$U$8:$U=$A42)+SUMIFS($W$8:$W,$V$8:$V,$A42)',
    '=SUMIFS($W$8:$W,$V$8:$V,$A42)',
    '=B42-C42'
  ]]);
  fillFormula_(sheet, 'B42:D42', 'B43:D43');
  putCell_(sheet, 'A43', 'Jane');

  putCell_(sheet, 'A44', 'Jajan Detail');
  mergeCells_(sheet, 'A44:D46');
  putBlock_(sheet, 'A47', [['=U7', '=V7', '=W7', '=X7']]);
  putCell_(sheet, 'A48',
      '=SORT(FILTER(\'Autodeduct Jajan\'!$B$2:$E,\'Autodeduct Jajan\'!$A$2:$A=EOMONTH($B$1,-1)+1),2,4\n)');
}

/** "List Items" panel (U4:AB86): this month's rows plus the per-row paid checklist. */
function buildDashboardListItems_(sheet) {
  putCell_(sheet, 'U4', 'List Items');
  mergeCells_(sheet, 'U4:AB5');

  putBlock_(sheet, 'U7', [[
    '=Saving!B1', '=Saving!C1', '=Saving!D1', '=Saving!E1', '=Saving!F1', '=Saving!G1',
    '=Saving!H1', 'Paid Automatic'
  ]]);

  putCell_(sheet, 'U8',
      '=SORT(IFERROR(VSTACK(\n' +
      'SORT(FILTER(INDIRECT(H$4&"!B:H"), INDIRECT(H$4&"!A:A")=EOMONTH($B$1,-1)+1),2,5),\n' +
      'SORT(FILTER(INDIRECT(L$4&"!B:H"), INDIRECT(L$4&"!A:A")=EOMONTH($B$1,-1)+1),2,5),\n' +
      'SORT(FILTER(INDIRECT(P$4&"!B:H"), INDIRECT(P$4&"!A:A")=EOMONTH($B$1,-1)+1),2,5),\n' +
      'SORT(FILTER(\'Autodeduct Jajan\'!$B$2:$H,\'Autodeduct Jajan\'!$A$2:$A=EOMONTH($B$1,-1)+1),2,4\n' +
      '))), 4,1,2,1,1,1)');
  insertCheckboxes_(sheet, 'AB8:AB' + TEMPLATE_DASH_LIST_LAST_ROW);
}

/** Cicilan summary (A63:F86): every instalment still running, with its end month. */
function buildDashboardCicilan_(sheet) {
  putCell_(sheet, 'A63', 'Cicilan Summary');
  mergeCells_(sheet, 'A63:F65');
  putBlock_(sheet, 'A66', [
    ['List', 'Type', 'Cicilan Amount', 'Payment Remaining', 'Remaining Amount', 'Month End']
  ]);

  putCell_(sheet, 'A67',
      '=SORT(QUERY(FILTER($U$8:$AA, $Y$8:$Y=TRUE), "SELECT Col1, Col2, Col3, Col6 - 1, ' +
      'Col3 * (Col6 - 1) LABEL Col6 - 1 \'\' , Col3 * (Col6 - 1) \'\'", 0), 3, 1)\n\n');
  putCell_(sheet, 'F67', '=IF(A67="","",EDATE($B$1,D67))');
  fillFormula_(sheet, 'F67', 'F68:F86');

}

/** Conditional formatting, in the original's priority order. */
function buildDashboardFormatRules_(sheet) {
  var C = TEMPLATE_COLORS;
  addFormatRules_(sheet, [
    // Instalment rows in the List Items panel.
    formulaRule_(sheet, 'Y8:Y68', '=Y8=TRUE', C.BLUE),
    // Paid / unpaid rows in the List Items panel.
    formulaRule_(sheet, 'U8:AB86', '=AND(NOT(ISBLANK($AA8)),$AA8=TRUE)', C.CHECK_GREEN),
    formulaRule_(sheet, 'U8:AB86', '=AND(NOT(ISBLANK($AA8)),$AA8=FALSE)', C.RED),
    // Saving and Ibadah want to reach their target; Expense wants to stay under.
    formulaRule_(sheet, 'I9', '=I9<J7', C.RED),
    formulaRule_(sheet, 'I9', '=I9>=J7', C.GREEN),
    formulaRule_(sheet, 'M9', '=M9<N7', C.GREEN),
    formulaRule_(sheet, 'M9', '=M9>=N7', C.RED),
    formulaRule_(sheet, 'Q9', '=Q9<R7', C.RED),
    formulaRule_(sheet, 'Q9', '=Q9>=R7', C.GREEN),
    SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty()
        .setBackground(C.CHECK_GREEN).setRanges([sheet.getRange('F37')]).build()
  ]);
}


/* ==========================================================================
 * Cell styling (data lives in TemplateFormats.js)
 * ========================================================================== */

/**
 * Applies the captured fonts, fills, alignment, number formats, borders,
 * column widths and row heights for one tab. Tabs without a spec are left alone.
 * @param {Sheet} sheet The freshly built tab.
 */
function applyTemplateStyles_(sheet) {
  var context = 'applyTemplateStyles_';
  try {
    // The source workbook's default cell format: vertically centred, 11pt Arial.
    // Cells inherit it, so the captured styles below only list what differs.
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns())
        .setVerticalAlignment('middle')
        .setFontSize(11);

    var spec = TEMPLATE_STYLES[sheet.getName()];
    if (!spec) return;

    spec.cols.forEach(function(run) { sheet.setColumnWidths(run[0], run[1], run[2]); });
    spec.rows.forEach(function(run) { sheet.setRowHeights(run[0], run[1], run[2]); });

    spec.fmts.forEach(function(fmt, index) {
      var ranges = spec.rects
          .filter(function(rect) { return rect[4] === index; })
          .map(function(rect) {
            return sheet.getRange(rect[0], rect[1], rect[2] - rect[0] + 1, rect[3] - rect[1] + 1);
          });
      applyTemplateFormat_(sheet, ranges, fmt);
    });
    logInfo(context, '"' + sheet.getName() + '": ' + spec.fmts.length + ' styles, ' +
        spec.rects.length + ' blocks.');
  } catch (e) {
    logError(context + ' > ' + sheet.getName(), e);
    throw e;
  }
}

/** Applies one style object to a set of same-styled ranges. */
function applyTemplateFormat_(sheet, ranges, fmt) {
  var list = sheet.getRangeList(ranges.map(function(range) { return range.getA1Notation(); }));

  if (fmt.bg) list.setBackground(fmt.bg);
  if (fmt.fg) list.setFontColor(fmt.fg);
  if (fmt.font) list.setFontFamily(fmt.font);
  if (fmt.size) list.setFontSize(fmt.size);
  if (fmt.bold) list.setFontWeight('bold');
  if (fmt.italic) list.setFontStyle('italic');
  if (fmt.underline) list.setFontLine('underline');
  else if (fmt.strikethrough) list.setFontLine('line-through');
  if (fmt.ha) list.setHorizontalAlignment(fmt.ha);
  if (fmt.va) list.setVerticalAlignment(fmt.va);
  if (fmt.nf) list.setNumberFormat(fmt.nf);

  ranges.forEach(function(range) {
    if (fmt.wrap) range.setWrapStrategy(SpreadsheetApp.WrapStrategy[fmt.wrap]);
    if (fmt.borders) applyTemplateBorders_(range, fmt.borders);
  });
}

/**
 * Draws a block's borders. Sides sharing a style and colour go in one call; the
 * interior lines are drawn when either neighbouring cell owns the shared edge.
 */
function applyTemplateBorders_(range, borders) {
  var byLook = {};
  Object.keys(borders).forEach(function(side) {
    var look = borders[side].join('|');
    (byLook[look] = byLook[look] || []).push(side);
  });

  var multiRow = range.getNumRows() > 1;
  var multiCol = range.getNumColumns() > 1;
  Object.keys(byLook).forEach(function(look) {
    var sides = byLook[look];
    var parts = look.split('|');
    var has = function(side) { return sides.indexOf(side) !== -1; };
    range.setBorder(
        has('top') || null,
        has('left') || null,
        has('bottom') || null,
        has('right') || null,
        (multiCol && (has('left') || has('right'))) || null,
        (multiRow && (has('top') || has('bottom'))) || null,
        parts[1],
        SpreadsheetApp.BorderStyle[parts[0]]);
  });
}
