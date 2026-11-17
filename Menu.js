/**
 * Master onOpen trigger.
 * Builds and mounts custom navigation menus across the spreadsheet workspace,
 * then puts the ledger sheets back in order.
 */
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();

    // --- 1. 💳 CC TRACKER TOOL ---
    // Every sync writes both the weekly CC Tracker and the permanent CC Transaction log.
    var syncSubMenu = ui.createMenu('CC Sync')
        .addItem('Sync Yesterday', 'runBCA_Yesterday')
        .addSeparator()
        .addItem('Sync Today', 'runBCA_Today')
        .addSeparator()
        .addItem('Sync Custom Date Range...', 'runBCA_CustomPrompt');

    var updateSubMenu = ui.createMenu('Update Tracker')
        .addItem('Paid by Selection', 'runPaidBySelection');

    var trackerAutomationMenu = ui.createMenu('Automation')
        .addItem('Rows Deletion for Paid/Cancelled', 'runDeleteCheckedRows');

    ui.createMenu('💳 CC Tracker')
        .addSubMenu(syncSubMenu)
        .addSeparator()
        .addSubMenu(updateSubMenu)
        .addSeparator()
        .addSubMenu(trackerAutomationMenu)
        .addToUi();

    // --- 2. 💵 FINANCIAL SYSTEM TOOL ---
    var monthlyProcessMenu = ui.createMenu('Monthly Process')
        .addItem('Generate Monthly Data', 'runGenerateMonthlyData')
        .addSeparator()
        .addItem('Add/Update/Delete Monthly Data', 'runManageMonthlyData')
        .addSeparator()
        .addItem('Simulate Monthly Budget (dry run)', 'runMonthlySimulation');

    var automationMenu = ui.createMenu('Automation')
        .addItem('Update Paid Status', 'runUpdatePaidStatus')
        .addSeparator()
        .addItem('Sort Ledger Sheets', 'runSortLedgerSheets');

    ui.createMenu('💵 Financial System')
        .addSubMenu(monthlyProcessMenu)
        .addSeparator()
        .addSubMenu(automationMenu)
        .addToUi();

    // --- 3. 🧩 TEMPLATE TOOL ---
    ui.createMenu('🧩 Template')
        .addItem('Generate Template...', 'runGenerateTemplate')
        .addSeparator()
        .addItem('Rebuild Template Tabs...', 'runRebuildTemplateTabs')
        .addToUi();

  } catch (e) {
    Logger.log("UI context unavailable: " + e.toString());
  }

  // Runs after the menus so a sort problem can never cost you the navigation.
  // sortLedgerSheets() reports failures instead of throwing; if the simple
  // trigger ever lacks write permission, attach it as an installable
  // "On open" trigger instead — no code change needed.
  sortLedgerSheets();
}
