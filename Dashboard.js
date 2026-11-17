/**
 * Dashboard.js — read-only reader for the Dashboard tab, used by the phone app.
 *
 * The layout is built by buildDashboardSheet_ in TemplateGenerator.js. If that
 * layout moves, change the addresses in DASHBOARD_READ here as well.
 */

/** A1 addresses of each Dashboard block the phone shows. */
var DASHBOARD_READ = {
  sheetName: 'Dashboard',
  allRange: 'A1:R86',           // one read covers every block below
  income: 'B4:C14',             // income labels and amounts
  cards: [
    { title: 'Saving', summary: 'H7:J9', categories: 'H12:J17' },
    { title: 'Expense', summary: 'L7:N9', categories: 'L12:N17' },
    { title: 'Ibadah', summary: 'P7:R9', categories: 'P12:R17' }
  ],
  channels: 'A21:D34',          // Payment Channel, Expected, Paid, Remaining
  jajan: 'A42:D43',             // Person, Jajan Amount, Deduction, Final Amount
  cicilan: 'A67:F86'            // List, Type, Cicilan Amount, Payment Remaining, Remaining Amount, Month End
};

/**
 * Converts a column label such as 'AB' to a zero-based index.
 * @param {string} letters Column letters.
 * @return {number} Zero-based column index.
 */
function dashboardColIndex_(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/**
 * Reads the Dashboard tab with one range call and returns its blocks as plain
 * display values. Blank rows inside a block are dropped.
 * @return {{missing: boolean, month: string, income: Array<Array<string>>,
 *     cards: Array<Object>, channels: Array<Array<string>>,
 *     jajan: Array<Array<string>>, cicilan: Array<Array<string>>}} Dashboard content.
 */
function readDashboard_() {
  var context = 'readDashboard_';
  try {
    var sheet = getBook_().getSheetByName(DASHBOARD_READ.sheetName);
    if (!sheet) return { missing: true };

    var values = sheet.getRange(DASHBOARD_READ.allRange).getDisplayValues();

    /**
     * Slices one rectangular A1 range out of the full read.
     * @param {string} a1 Range such as 'H12:J17'.
     * @return {Array<Array<string>>} Rows of the range that hold at least one value.
     */
    var block = function (a1) {
      var m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a1);
      if (!m) throw new Error('Bad Dashboard range: ' + a1);
      var c1 = dashboardColIndex_(m[1]);
      var r1 = parseInt(m[2], 10) - 1;
      var c2 = dashboardColIndex_(m[3]);
      var r2 = parseInt(m[4], 10) - 1;

      var out = [];
      for (var row = r1; row <= r2; row++) {
        var line = values[row] ? values[row].slice(c1, c2 + 1) : [];
        var hasValue = line.some(function (cell) { return cell !== ''; });
        if (hasValue) out.push(line);
      }
      return out;
    };

    var result = {
      missing: false,
      month: values[0][dashboardColIndex_('B')],
      income: block(DASHBOARD_READ.income),
      cards: DASHBOARD_READ.cards.map(function (card) {
        return { title: card.title, summary: block(card.summary), categories: block(card.categories) };
      }),
      channels: block(DASHBOARD_READ.channels),
      jajan: block(DASHBOARD_READ.jajan),
      cicilan: block(DASHBOARD_READ.cicilan)
    };
    logInfo(context, 'month=' + result.month);
    return result;
  } catch (e) {
    logError(context, e);
    throw e;
  }
}
