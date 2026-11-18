# Financial Tracker System

This repository contains the Google Apps Script project for the Financial Tracker System, integrated locally via `clasp`.

## Technical Stack & Configuration

* **Runtime**: Google Apps Script (V8 Engine)
* **Local Integration**: Clasp (Command Line Apps Script Projects), installed globally: `npm install -g @google/clasp`. The repo has no npm dependencies.
* **Script IDs**: kept only in the local, gitignored `.clasp-test.json` (TEST) and `.clasp-prod.json` (PROD). Copy `.clasp.example.json` to each and paste the ID from that project's Apps Script settings. They are not committed because this repository is public.
* **Phone app**: a PWA in `web/` (vanilla ES modules, no build step), published to GitHub Pages. See [Phone app (PWA)](#phone-app-pwa).
* **Time zone**: `Asia/Jakarta` in `appsscript.json` — must match the spreadsheet (File → Settings), or dates read from the sheet land in the wrong month.

## Project Structure

All `.js` files share one global namespace in Apps Script, so each file is a feature boundary rather than a module.

| File | Responsibility |
| --- | --- |
| `Menu.js` | `onOpen` trigger; builds the three menus (**💳 CC Tracker**, **💵 Financial System**, **🧩 Template**), then sorts the ledgers. |
| `Common.js` | Shared constants and helpers: ledger column map, date/currency formatting, single-read sheet snapshots, Master sheet option lists. No UI, no feature logic. |
| `LedgerSort.js` | Sorts `Income`, `Saving`, `Expense` and `Ibadah` on open. |
| `MonthlyGeneration.js` | **Generate Monthly Data** — the M-1 → target month rollover (candidate scan, jajan allocation, upsert merge, audit report). |
| `FinancialSystem.js` | **Monthly Data** — the single add/update/delete form. |
| `PaidStatus.js` | **Update Paid Status** — ticks `Sudah Bayar?` from the Dashboard checklists; trigger-safe. |
| `TemplateGenerator.js` | **Generate Template** — builds the empty workbook (all tabs, formulas, checkboxes, dropdowns, conditional formatting) in any spreadsheet. Every tab is sized to the source workbook's exact grid (e.g. Finance -> 1×1, Dashboard 86×28, CC Tracker 480×11, CC Transaction 1000×7, Blu Balance 1021×36) by `fitTemplateSize_`, which grows or trims the default 1000×26. Skips tabs that already hold content. Menu: **🧩 Template → Generate Template...**, or call `generateFinancialTemplate(idOrUrl)`. **Rebuild Template Tabs...** erases and rebuilds ticked tabs (any tab, data tabs included); a second checklist picks which of them get a `<tab> (backup <timestamp>)` copy first, the rest are erased without one; tabs are cleared in place, never deleted, so other tabs' formulas keep working. Cell styling lives in `TemplateFormats.js`. |
| `TemplateFormats.js` | Generated data, not logic: the `TEMPLATE_STYLES` object holding per-tab cell styles captured from the source workbook. Applied by `applyTemplateStyles_()`; regenerate rather than hand-edit. |
| `Simulation.js` | **Simulate Monthly Budget** — read-only what-if for one month (see below). |
| `CcSync.js` | Credit card sync into `CC Tracker` and `CC Transaction`, plus the tracker's "paid by selection" tools. |
| `RowCleanup.js` | **CC Tracker → Automation → Rows Deletion for Paid/Cancelled** — deletes whole settled rows (`I` Paid or `J` Cancelled ticked), then restores the tracker grid. `deleteCheckedRows()` is UI-free and trigger-safe; the menu path confirms through `RowDeletionDialog.html`. |
| `Api.js` | Web app entry: `doGet`/`doPost`, the action table, input validation. |
| `Auth.js` | Token and Google ID-token allowlist check, failure throttle, `authorizeApi`. |
| `Dashboard.js` | Read-only reader of the Dashboard tab for the phone. |
| `*Dialog.html` | One HtmlService dialog per feature, loaded by name (`createTemplateFromFile('<Name>')`): `MonthlyDataDialog` and `LoadingSummaryDialog` (Generate Monthly Data), `MonthlyDataEntryDialog` (Monthly Data form), `SimulationDialog`, `AutomationSummaryDialog` (Update Paid Status), `PaidBySelectionDialog` (CC Tracker), `RowDeletionDialog` (Rows Deletion). |

`web/` holds the phone app and is excluded from clasp by `.claspignore`, an allowlist that pushes only `appsscript.json`, `*.js` and `*.html` from the root.

The repository root is flat on purpose — every source file sits next to `appsscript.json` and is pushed as-is. Do not add subfolders: clasp turns folder paths into file names, which would break the by-name dialog lookups.

### Ledger sheet contract

`Saving`, `Expense`, `Ibadah` and `Autodeduct Jajan` share the same eight columns (see `LEDGER_COLUMNS` in `Common.js`):

`A Date` · `B List` · `C Type` · `D Amount` · `E Note/Channel` · `F Cicilan?` · `G Payment Remaining` · `H Sudah Bayar?`

`Income` uses only `A Date` · `B Person` · `C Category` · `D Amount`. Column A always holds the first day of the month the row belongs to (`yyyy-MM-01`).

### Generate Monthly Data flow

1. `runGenerateMonthlyData()` opens `MonthlyDataDialog.html`.
2. `getMonthlyInitializationPayload(monthIndex, year)` returns Master lists plus the M-1 rollover candidates. `monthIndex` is **0-based**, so August is `7` and the source month is always `monthIndex - 1`.
3. `showLoadingAndSummary(formData)` swaps in `LoadingSummaryDialog.html`.
4. `executeMonthlyGeneration(formData)` merges the ledgers and returns the audit report.

The dialog opens on **the current month**, so August defaults to writing August from July. January is safe: `monthStartString_` accepts a `-1` month index and rolls the source back to the previous December.

Which month is "current" is decided by the server, not the browser: `runGenerateMonthlyData` stamps `currentMonthKey()` into the dialog as `DEFAULT_MONTH`. That reads the clock in the **spreadsheet's own timezone**, so a machine set to another timezone cannot open the form on a different month from the one the ledger dates land in. The browser clock is only a fallback for an untemplated file.

The merge is an **upsert**: a row that already exists for the target month is updated in place, anything else is appended, nothing is deleted. Re-running the same month is therefore idempotent.

#### What the rollover can and cannot do to a row you added yourself

The rollover **never removes a row**, and it never moves one. A row you entered through the Monthly Data form is affected at all only when a ticked candidate carries the same `List` + `Type` + `Note/Channel`, and then only its `Amount`, `Cicilan?`, `Payment Remaining` and `Sudah Bayar?` are rewritten from M-1 — that is the upsert doing its job. Give the row a `List` or `Note/Channel` no rollover candidate uses and nothing will ever touch it. Untick that item in the Generate dialog and the same holds.

The one place that could ever clear a cell is `clearBlankTrailingRows_`, and it is deliberately defensive. `readLedgerSnapshot_` treats the last row with a date in column A as the end of the ledger, so **a row typed without a date sits below the ledger** as far as the merge is concerned. Rather than clearing that span wholesale, every trailing row is inspected: one holding content in any column is left alone and logged, and only rows blank end to end (a formula rendering to `''`, a stray space) are cleared. Since the upsert never shrinks the ledger, this can never be undoing the merge's own work.

If the Apps Script log reports rows left untouched below the last dated row, fill in their column A date — that is what brings them into the ledger, the on-open sort and the Monthly Data form.

Every write that grows a sheet goes through `ensureRowCapacity_` in `Common.js` first. A sheet trimmed to exactly its data has no spare rows at the bottom, and `getRange()` past the last one throws rather than growing the grid, so the rollover's appended block, the Monthly Data form's new rows and the BCA extraction paste all insert the rows they need before writing.

#### Installments (Cicilan)

The candidate scan only looks at rows dated **strictly before the target month**. That cut-off is what keeps a re-run idempotent: rows the rollover itself wrote sit *in* the target month, so a second Generate can never read one back and decrement it twice.

For each item (matched on `List` + `Type` + `Note/Channel`) the scan keeps the row from the **latest month before the target** — its most recent state. If that row has **1 payment or fewer remaining the installment is finished** and the item is dropped, because the final payment has already been booked.

Latest-month rather than fewest-payments matters when an installment is **restructured**: a restructure can raise the payment count as easily as lower it, and picking the smallest count would let a stale older row — and its old amount — override the restructured one. For an untouched installment the two rules agree, since the latest month is also the one with the fewest payments left. Two rows in the same month are a data slip, so there the smaller count breaks the tie. See `isMoreRecentState_`.

Pass 1 spans **every** earlier month, not just M-1, so an installment that was **paused** still resumes from where it left off. July holds 5 payments remaining, August through October are skipped entirely, and generating November writes 4 remaining at July's amount — the count only moves when a row is actually written, never per calendar month. (Only the plain, non-installment pass is restricted to M-1.)

To record a restructure, generate the month as usual and then edit that row's `Amount` and `Payment Remaining` in the Monthly Data form. The next month's generation picks the restructured row up as the latest state and carries on from there. Re-generating *that* month would rewrite the edit from M-1 again, so do the edit last, or untick the item.

Worked example — July holds `Cicilan HP` with 3 payments remaining:

| Action | Candidate read from | Written to target |
| --- | --- | --- |
| Generate August | July, 3 left | August, **2 left** |
| Generate August again | July, 3 left | August, **2 left** (unchanged) |
| Generate September | August, 2 left | September, 1 left |
| Generate October | September, 1 left → finished | nothing |
| Generate August again, after Sep/Oct exist | July, 3 left | August, **2 left** |

#### Income

Income is the one section with no checklist. The ledger holds one row per person per category and the dialog holds exactly one box for each, so there is nothing to tick — instead every box **opens on the source month's figure**, summed per person and category, and you adjust from there. A category with no row in M-1 starts at zero, and the card note says which month the figures came from.

`loadIncomeDefaults_` builds the `{person: {category: amount}}` map that seeds the form. Only `Wiva` and `Jane` are offered (`INCOME_PERSONS`); a row belonging to anyone else is counted in the log and skipped, since the dialog has no column for it. Lookup between the Income sheet's category text and the Master list is normalized (trimmed, case-insensitive), so a stray capital cannot leave a box at zero.

Because the boxes are seeded before the first `recalculate()`, the jajan pool and both Net Jajan figures open on last month's numbers too, rather than on zero.

#### Two tabs: rollover, and the target month

The dialog splits at the top level:

* **Rollover from M-1** — income, the jajan allocation, and the per-sheet candidate checklists. Unchanged.
* **Already in target month** — every row already dated in the month being generated, where amounts can be edited, rows ticked for removal, and new rows added.

Those edits are written **before the rollover reads a single sheet** (`applyTargetMonthEdits_`, called at the top of `executeMonthlyGeneration`), so every snapshot below it — and therefore the whole jajan calculation — sees the month the user just corrected. It delegates to `applyMonthlyDataChanges`, so there is one code path that writes ledger edits, signature guard and all, and the dialog's month is overwritten with the rollover's own target so a stale form cannot write into a different month.

`Net jajan after these edits` sits at the bottom of the tab and moves as you type, because `carriedAutodeduct()` reads the tab's live DOM rather than a figure the server sent. Removing an autodeduct row or retyping its amount moves the budget immediately.

**The tab edits amounts only — and that is load-bearing.** `applyMonthlyDataChanges` rewrites *every* editable column on an update, so a payload carrying just the amount would clear `Cicilan?`, `Payment Remaining`, `Note/Channel` and `Sudah Bayar?` on the row it touched. Each update therefore carries those four back **verbatim**, exactly as they arrived from `loadTargetMonthRows_`. An installment edited here keeps its flag and its remaining count; the row shows a `cicilan · N left` badge so it is recognisable as one. Rows nobody touched send nothing at all.

The candidate scan is **not** affected by any of this. It still reads rows dated strictly before the target month, so an installment can never be read back and decremented twice, and the tab only ever lists target-month rows — there is no way to reach an M-1 row from it.

Income is deliberately absent from the tab: its target-month figures are the prefilled boxes on the rollover tab, and editing the same numbers in two places would leave the form arguing with itself.

`activateTab` resolves panels within the clicked tab's **own strip**. There are two strips now, and a handler that reached across both would blank the per-sheet panels every time a top-level tab was clicked.

#### Re-running: the rollover tab only lists what is missing

`getMonthlyInitializationPayload` runs every candidate through `splitCandidatesByTarget_`. A candidate whose `List + Type + Note/Channel` already exists in the target month — whatever its amount was edited to — is **dropped from the rollover checklists**, and the target-month row it matched is flagged `fromRollover` and shown with a green **from rollover** badge and tint. Rows added by hand stay plain. Delete a rolled-over row from the target month and its candidate is offered on the rollover tab again on the next open.

Because hidden candidates are never ticked, they cannot overwrite an edited amount, and the jajan total still counts their rows (every existing Autodeduct row no ticked candidate replaces). The rest of this section describes what happens when a candidate is still shown and ticked — for instance one you added by hand with the same identity after opening the dialog.

On a re-run the two tabs are populated from overlapping items, which looks like it should double up, and it does not:

* The target-month tab **never re-sends existing rows**. It emits an update only for a row whose amount you changed, a deletion only for one you ticked, and additions only for rows you typed in yourself. Touch nothing and it sends nothing.
* The rollover is an **upsert**. `mergeLedgerRows_` indexes the target month by `List + Type + Note/Channel` and updates a match in place; only unmatched candidates are appended.

So a plain re-run writes over the same rows and adds nothing.

What the two tabs *can* do is quietly undo each other, because the rollover runs **after** the target-month edits:

| You do this on the target-month tab | …with the item still ticked on the rollover tab |
| --- | --- |
| Edit an amount | The rollover overwrites it with the M-1 amount |
| Tick a row for removal | The rollover re-appends it |

Neither duplicates anything, but both throw away what you just did. `markRolloverOverlap` makes it visible instead of surprising: a row a ticked candidate matches is flagged **rollover overwrites this**, and one you have also marked for removal turns into **rollover puts this back** with an amber caution on the action bar naming the rows. Untick the item on the rollover tab and both clear. The run is never blocked — it is a caution, not an error, because writing the M-1 figure over your edit is sometimes exactly what you want.

`loadCandidateIdentities_` supplies the matching, over all four rollover sheets, keyed by candidate uid. Identities are namespaced by sheet: the same `List + Type + Note/Channel` can appear on more than one ledger, and the dialog compares across all of them at once.

#### The jajan deduction counts the target month, not just M-1

`buildAutodeductPlan_` totals **everything that will sit in the target month once the run finishes**, not only what rolled over:

* every ticked candidate, at its overridden amount when one was typed; plus
* every autodeduct row **already dated in the target month** that no ticked candidate is going to replace.

That second half matters because rows reach the target month without passing through the rollover at all. The Monthly Data form can add next month's autodeductions before that month is ever generated — and a previous run's rows are already sitting there on a re-run. Counting only the candidates wrote a Jajan budget that ignored them, silently undoing the deduction the form had applied when the row was created.

Double counting is avoided the way the merge avoids it: a planned row **claims** one existing row of the same `List + Type + Note/Channel`, because it is about to overwrite it. `addExistingAutodeductions_` shifts the same match queue `mergeLedgerRows_` uses, so the two always agree. Re-running a month is still idempotent — the rows the first run wrote are claimed by the same candidates on the second.

Note the **candidate scan itself still ignores the target month**, and must keep doing so: rows the rollover wrote sit *in* that month, so scanning it would read an installment back and decrement it twice. Only the jajan arithmetic looks at the target month, never the rollover source.

An owner cell naming neither person is now skipped rather than folded into Jane, which is what the old owner-or-else test did — a typo in the `Type` column quietly moved somebody else's budget. Unrecognised owners are logged.

The dialog matches, and stays matching while you edit. `loadCandidateIdentities_` sends the merge identity each autodeduct candidate would claim — built server-side because `rowIdentityKey_` tags values by type, which the browser cannot reproduce from a candidate's display strings. `carriedAutodeduct()` then totals the target-month tab's live autodeduct rows and drops the one each ticked candidate is about to overwrite. Without this the preview would promise a bigger budget than Generate writes.

#### Per-row amount overrides

Every rollover row on all four tabs carries an override box beside its amount — a tinted `same` field at the right edge of the row. Leave it blank and the M-1 amount rolls over unchanged; type a figure and that is what gets written to the target month instead, with the original amount struck through. Overriding an **Autodeduct** row also lowers that person's Net Jajan live, since autodeductions come out of the jajan pool.

That box is styled `.check-row input.check-override`, qualified with `input` on purpose. The base `input[type="text"]` rule and the row's checkbox rule are both more specific than a bare class, so an unqualified `.check-override` loses the cascade and the field collapses to the checkbox's 15px — present in the DOM but invisible on screen. Keep the type qualifier if you touch it.

Overrides travel to the server as an `{uid: amount}` map and are applied in `resolveAmount_`. Only ticked rows are sent, and anything that is not a finite non-negative number is discarded server-side rather than written.

#### Summary ordering

Each section of the completion summary (and the Apps Script audit log) lists its rows by **payment channel A-Z, then amount descending** inside each channel. Income rows have no channel, so they group together at the top. See `byChannelThenAmountDesc_` in `MonthlyGeneration.js`.

### Monthly Data form

**💵 Financial System → Monthly Process → Add/Update/Delete Monthly Data** opens `MonthlyDataEntryDialog.html`, one form covering all three operations for a single month:

It also opens on **the current month**, from the same server-side `currentMonthKey()` as the rollover dialog.

* **Existing entries** — every row dated in the chosen month, grouped by sheet. `Amount`, `Note/Channel`, `Cicilan?`, `Payment Remaining` and `Sudah Bayar?` are editable; `List` and `Type` are not. Income rows expose the amount only. Tick `Del` to remove a row.
* **Add new** — new rows, **each with its own destination sheet** (`Saving`, `Expense`, `Ibadah`, `Autodeduct Jajan`), so one save can land a Saving row and an Expense row together. A fresh row starts on the sheet of the row above it, which keeps a run of rows for one sheet to a single click each. Changing a row's sheet refills only that row's `Type` list, and a category both sheets offer is kept rather than cleared. Income rows are edit/delete only.

  **New rows do not use the shared column grid.** Nine controls will not read on one line in a 750px dialog, and widening them into a sideways scroll only trades cramping for hunting. Each new row is a two-line card instead — `Sheet · List description · Amount · delete` on top, `Type · Channel · Cicilan · Left · Paid` underneath — with every field labelled above its control and nothing below its readable width. There is no horizontal scrolling in this panel at all; `.grid-scroll` still caps the height so the list scrolls vertically.

  `.add-row` is deliberately **absent** from the `.grid-head, .entry-row` rule. It used to be listed there, and overriding `display` in a later rule does not undo the `align-items: center` that rule also sets — a column flex container then centres each line at its content width instead of stretching it, which collapsed the Type and Channel selects to the width of their own text. If you add a row style, keep it out of the grid selector.

  Alignment is structural, not tuned: every child of `.add-line` is the same label-over-control shape, and the line aligns to the top. A checkbox or the delete button sits in a `.field-box` that is exactly one input tall, which is what puts it on the same baseline as a text box without offsets measured against font metrics. It also lets the amount's formula preview grow downwards without dragging the rest of the line with it. `.field-sheet` is fixed at 150px, the width of `Autodeduct Jajan`.

#### Autodeduct rows move the jajan budget

The rollover derives each person's Expense `Jajan` row as *gross jajan share − their autodeductions* (`calculateJajanAllocation_`). Editing `Autodeduct Jajan` by hand has to keep that true, so **every applied change to that sheet moves the matching Jajan row by the same figure**: add a 220.000 autodeduction for Wiva and Wiva's `Jajan` for that month drops 220.000.

The adjustment is symmetric, which is why it is a signed delta rather than a rule about additions: lowering an autodeduction hands the difference back, and deleting one returns it in full. Only rows that actually land count — a row skipped for a stale signature moves nothing.

`applyJajanAdjustment_` runs after every sheet is written and **re-reads Expense**, so if the same save also edited a `Jajan` row, the adjustment lands on the value just written instead of racing it. The result is clamped at zero and reported back in the toast.

If a person has no `Jajan` row in that month there is nothing to deduct from. That is reported in the skipped list rather than invented — a row created here would be a negative budget with no gross share behind it. Generate the month first, then add the autodeduction.

Owner spelling lives in `Common.js`: `normaliseJajanOwner_` maps `Wiva`/`Rio` and `Jane` to one name, and `isJajanRow_` identifies the category. Both files use them — `Autodeduct Jajan` holds the owner in `Type`, the Expense `Jajan` row holds it in `List`.

New rows are written **straight after the last dated row** (`firstFreeLedgerRow_` in `Common.js`). `sheet.getLastRow()` cannot be used for this: the template's unticked `Cicilan?` / `Sudah Bayar?` checkboxes hold `FALSE` down to row 1000, so it pointed past them and every addition landed below a gap until the on-open sort pulled it back up. The `Cicilan?` and `Sudah Bayar?` checkbox columns are ignored when deciding whether a row is free, ticked or not: a row whose only value is a checkbox counts as empty. An undated row with anything in its other columns (typed text, a number) is still never overwritten; new rows go below it.

Amount fields accept a plain number or an arithmetic expression: `120.000*2` is saved as `240.000`, with the result previewed under the field as you type.

The eight ledger columns do not fit the 750px dialog, so each section scrolls inside its own `.grid-scroll`, with the header row frozen to the top and the `List` column frozen to the left. The header row and the data rows sit in the same `.grid-scroll-inner`, which carries the shared `min-width` — that single width is what keeps the columns lined up while the section slides. Income has only four columns and gets a narrower `min-width`, so it never scrolls. If you add or resize a column, update the matching `min-width` too or the header will drift off its rows.

`.grid-scroll` owns **both** axes (`overflow: auto` plus a `max-height`), which is why each section scrolls vertically inside itself rather than with the page. A sticky header can only freeze against the scrollport it sits in, so an outer page scroll combined with an inner `overflow-x` would leave it stuck to nothing.

The frozen cells pin at their row's content edge (`left: 10px` for rows, `9px` for the header, matching the 1px border rows carry and the header does not) and repaint the gutter they leave behind with a `-9px` solid shadow. Nine pixels, not more: the row's 1px left border has to survive. The colour comes from `--row-bg`, which each row state redefines, so an edited or doomed row keeps its tint under the frozen cell instead of showing a grey patch. The divider on the frozen column's right edge is toggled by `is-scrolled-x` so it only appears once the column is actually holding its place.

Each existing-entries section is listed in **the same order as its sheet** — `Income` by Person then Category, the ledger tabs by Type, Note/Channel then List. The form does not keep its own copy of that order: `getLedgerSortFields()` translates `LEDGER_SORT_KEYS` into field names and the payload carries them to the dialog, so changing `LEDGER_SORT_KEYS` moves both. `Date` is dropped from the keys because every listed row shares the chosen month, and blank channels sort last just as they do in Sheets. All three of a staged row's selects — sheet, type and channel — are rebuilt by `refreshAddRowOptions` on every reload, not just sheet and type. A row staged before a reload would otherwise keep the previous month's lists, and one built while a list was still empty would keep showing nothing to choose from. When `Master I3:I` yields no payment channels the Channel select says so outright, because a lone `—` looks identical whether the list is empty or the row simply has no channel yet.

`Autodeduct Jajan` has no entry in `LEDGER_SORT_KEYS` (the on-open sort skips it), so the form falls back to the shared ledger order. New rows under **Add new** stay in the order you create them.

#### The footer strip

Three cards sit above **Save Changes** — one count, two money figures:

| Card | Shows |
| --- | --- |
| `N / E / D` | Rows being created, edited and deleted, in that order. |
| `Paying now` | Amounts of rows you are ticking **Paid** in this session. |
| `Left unpaid` | What the month still owes once these changes are saved. |

The three counts share one card rather than taking three: they are the same kind of fact, they are rarely all non-zero, and one card each left no room for figures that actually carry rupiah. A zero is dimmed and the slashes are muted, so the digits that matter are what you read. `setCounts` builds that markup — the values are integers from `collectChanges`, so there is no escaping question.

`Paying now` counts only rows being ticked *now*: a row that arrived already ticked is money settled before today, and including it would make the card a month-to-date total rather than "what this save pays". A new row created with Paid ticked does count, since it has no earlier state. `Left unpaid` is the opposite kind of number — it is the month's position, not a change, so untouched rows count towards it too and rows marked for deletion do not.

Income rows have no Paid column and are skipped by both. That also keeps the strip free of the sign problem a "net change" card would have: money in and money out cannot be summed into one figure.

The strip wraps rather than squeezing (`flex-wrap`), so a long figure drops a card to a second line instead of crushing all three.

One CSS trap worth keeping in mind: the card label rule is `.stat > span`, deliberately a direct-child selector. The value line holds spans of its own, and an unqualified `.stat span` restyles them as 10px uppercase blocks — which stacks `N / E / D` vertically down the card.

One **Save Changes** applies everything at once. Two server calls do the work:

| Function | Responsibility |
| --- | --- |
| `getMonthlyEntryPayload(monthStr)` | Master option lists plus the month's rows, in one round trip. |
| `applyMonthlyDataChanges(payload)` | Validates the whole submission, then writes each sheet once. |

Row deletion is shared, not duplicated: `deleteRowsDescending_` lives in `Common.js` because `RowCleanup.js` deletes ledger rows too. All `.js` files share one Apps Script global scope, so a second copy in a feature file silently shadows the first at load time — which is exactly how a version that returned no count once turned this form's result into a bare "unknown error". Keep one definition.

Nothing is written until every row validates, so a bad value aborts the submission rather than leaving the ledgers half-changed. Each row also carries a signature of the columns the form cannot edit (`Date` + `List` + `Type`); if that no longer matches when the write happens, the row is skipped and reported instead of being overwritten — which is what stops a stale dialog from clobbering a sheet that moved underneath it. Within a sheet, updates are applied first, additions are appended, and deletions run last from the bottom up so earlier row numbers stay valid.

### Ledger sorting on open

`onOpen` calls `sortLedgerSheets()` after building the menus. It reorders data rows only — never the header, never a value, and never anything parked below the last dated row. `Autodeduct Jajan` is left alone.

| Sheet | Sort order (all ascending) |
| --- | --- |
| `Income` | Date, Person, Category |
| `Saving` / `Expense` / `Ibadah` | Date, Type, Note/Channel, List |

Date leads so the newest month stays at the bottom, which is how the sheets already grow and what keeps the monthly merge writing the smallest possible block. Change the order in one place: `LEDGER_SORT_KEYS` in `LedgerSort.js` — it also drives how the Monthly Data form lists each section.

A sheet with only a header (or a single data row) is skipped. Failures are logged and returned rather than thrown, so a sort problem can never stop the spreadsheet from opening or cost you the menus.

**If the simple trigger lacks permission to write**, attach `sortLedgerSheets` as an installable *On open* trigger — the function needs no changes. In that case remove the `sortLedgerSheets();` call at the end of `onOpen` in `Menu.js` so it does not run twice.

You can also sort on demand: **💵 Financial System → Automation → Sort Ledger Sheets**.

### Update Paid Status

**💵 Financial System → Automation → Update Paid Status** marks ledger rows as paid (`H Sudah Bayar?`) for the month in `Dashboard!B1`. Any date in that month works: both B1 and ledger column A are compared as `yyyy-MM-01`.

Two Dashboard checklists are combined with **OR**:

| Checklist | Default location | Effect |
| --- | --- | --- |
| Per payment channel | names `A21:A34`, boxes `E21:E34` | Every unpaid row of that channel in the month. |
| Per row | `U` List · `V` Type · `X` Payment Channel, boxes `AB8:AB68` | Only the ledger row with the same List + Type + Channel in the month. |

A row picked by both is marked once. Matching ignores letter case and surrounding spaces, and searches `Saving`, `Expense`, `Ibadah` and `Autodeduct Jajan`. Every ticked Dashboard box is cleared afterwards, so a tick is a one-time instruction.

**Changing the layout:** edit the `PAID_STATUS_CONFIG` block at the top of `PaidStatus.js`. Rows are sheet row numbers and columns are column letters, exactly as shown in the spreadsheet.

Only the changed `H` cells and the ticked checkboxes are written (via `RangeList`), so formulas elsewhere on the ledgers and the Dashboard are never overwritten. The dialog groups the result per payment channel and lists ticked rows that matched no ledger row.

**Daily trigger:** point a time-driven trigger at `updatePaidStatus` (not `runUpdatePaidStatus`, which opens a dialog). It holds the document lock, returns quietly when nothing is ticked, and throws on real problems such as a missing Dashboard or an invalid month, so the trigger reports those.

### Simulate Monthly Budget (dry run)

**💵 Financial System → Monthly Process → Simulate Monthly Budget (dry run)** opens `SimulationDialog.html`. It **never writes**: `getSimulationPayload` only reads, and every change lives in the dialog until it closes.

**Baseline, per sheet (hybrid).** A ledger that already has rows dated in the chosen month starts from those rows (`from sheet` badge). A ledger with none starts from what Generate Monthly would roll over from M-1 (`projected` badge), using `collectRolloverCandidates_`, with installments shown one payment lower. Income follows the same rule.

**Layout:** one tab per section — Income · Jajan · Saving · Expense · Ibadah · Autodeduct — each showing its running total, like the Generate Monthly Data dialog, so the dialog never becomes one long page. The summary strip stays pinned above the tabs, and long item lists scroll inside their tab.

**What you can change:** every income box, the Jajan pool rate, split and counted income categories, and on each of Saving / Expense / Ibadah / Autodeduct: untick a row to drop it, type an amount to override it (`same` = unchanged; `1.250.000` and `120.000*2` both work), or **+ Add item**. **Reset** throws the scenario away.

**Remaining = Income − Saving − Expense − Jajan (net) − Ibadah − Autodeduct.** The Expense `Jajan` rows hold the *net* budget (gross share − autodeductions), so they are pulled out of Expense and recalculated live. Net Jajan + Autodeduct = gross share, so nothing is counted twice. A side effect is worth knowing: adding or dropping an autodeduct row moves money between Autodeduct and Jajan, and **Remaining only moves once autodeductions exceed that person's gross share** (net Jajan is clamped at zero).

Net Jajan moves by *changes* from the baseline: `net = baseline net + Δgross − Δautodeduct`. When the month already has Jajan rows, their figures are the baseline and the pool rate and split are inferred from them (gross = net + autodeduct over Salary income), so an untouched simulation shows exactly what is on the sheet. With no Jajan rows, or a net clamped at zero, the Generate defaults are used (10%, 50/50, Salary).

The summary strip shows every figure in rupiah, as a % of income, and as a change against the untouched baseline.

### CC sync: CC Tracker and CC Transaction

**💳 CC Tracker → CC Sync** (Yesterday / Today / Custom range) reads the card notification emails once and writes two sheets:

| Sheet | Role | Layout |
| --- | --- | --- |
| `CC Tracker` | Weekly working sheet, deleted and rebuilt each week. | Headers on row 7; the sync writes `A:G` (`Datetime · Bank · Card Number · Description · Type · Amount · Currency Code`) from row 8. `H` Select · `I` Paid · `J` Cancelled · `K` Note. Summary `B2:B5` sums `F`. A missing tab is skipped and reported, never an error. |
| `CC Transaction` | Permanent log, every card. Created automatically if missing. | Row 1 headers: `Datetime · Bank · Card Number · Description · Type · Amount · Currency Code`. |

**Both sheets look the same.** Every data row uses `CC_DATA_FONT` (Calibri), and number formats are fixed per column (`CC_TRACKER_NUMBER_FORMATS` / `CC_TRANSACTION_NUMBER_FORMATS` in `CcSync.js`): Datetime as `yyyy-mm-dd hh:mm:ss`, Amount as `#,##0`, and every text column (Bank, Card, Description, Type, Currency, Note) as plain text `@`, so a merchant such as "7-11" or a note such as "12/5" is never read as a date. They are set before each new row is written and re-applied to the whole table on every sync and clean, because sorting and row deletion move cell formats around.

**Fill colours** cover whole rows `A8:K`: Cancelled (`J`) red, Paid (`I`) green, Selected but unpaid (`H` without `I`) orange, in that priority order.

**The grid survives the weekly clean.** Rows Deletion for Paid/Cancelled deletes whole rows, which used to shrink the 480-row template grid for good, and rows the sync appended past the end arrived without checkboxes or colours. `restoreCcTrackerRows_` (in `CcSync.js`) now runs after every deletion and every tracker write: it tops the grid back up to 480 rows, gives any row without a checkbox, at the end or in the middle, row 8's formats and fresh `H:J` checkboxes (rows that already have one are never touched, so no tick is reset), and points the three colour rules at `A8:K` down to the last row.

On the tracker, a transaction already in `A:G` (same seven values) is **skipped before writing**, the same check CC Transaction uses, so re-syncing a day adds nothing. Duplicates are never written and removed afterwards: Sheets' Remove duplicates shifts cells up inside its range and strips the formats and checkboxes off the rows just below the data. The Datetime sort moves **whole rows `A:K`**, so ticks and notes stay with their transaction even when a late, older one is sorted into the middle.

The log only appends transactions it does not already hold (fingerprint: all seven columns — datetime, bank, card, description, type, amount, currency), then sorts by Datetime. Columns you add to the right of `G` sort with their row and are never overwritten.

**Config** is the block at the top of `CcSync.js`, in separate sections: `CC_TRACKER_*` (sheet name, header row, raw block position, and `CC_TRACKER_COLS` for every column the checklist tools read), `CC_TRANSACTION_*` (sheet name and headers), and `CC_SOURCES`. If you move a tracker column, change `CC_TRACKER_COLS`, `ROW_CLEANUP_TARGETS` in `RowCleanup.js` and `buildBcaTrackerSheet_` in `TemplateGenerator.js` together. **To add another card**, append a `CC_SOURCES` entry with its `bank` label, Gmail `query` and a `parse` function returning `{timestamp, card, merchant, type, amount, currency}` (or `{error}`); both sheets pick it up.

**Daily trigger:** point a time-driven trigger at `runBCA_Yesterday` (names kept from the BCA-only version so existing triggers keep working).

## Phone app (PWA)

The phone app lives in `web/`, is served from GitHub Pages in two builds (PROD at `https://wivawilana67.github.io/financial-tracker-system/`, TEST at `https://wivawilana67.github.io/financial-tracker-system/test/`), and talks to the Apps Script web app over HTTP. The sheet functions above run unchanged; the phone only reaches them through the action table below.

### Environments: TEST and PROD

There are two complete environments: TEST for every development step, PROD for releases. Each one has its own branch, phone URL, sheet, Apps Script project and tokens.

| | TEST | PROD |
| --- | --- | --- |
| Git branch | `develop` (GitHub default branch; all work is committed here) | `master` (release; changes only by merging `develop`) |
| Phone URL | `https://wivawilana67.github.io/financial-tracker-system/test/` | `https://wivawilana67.github.io/financial-tracker-system/` |
| Google Sheet | "Financial Tracker (TEST)", a File → Make a copy of the real sheet | the real sheet |
| Apps Script | the copy's bound script (own Script ID and `/exec` URL) | the real sheet's bound script |
| Local clasp target (gitignored) | `.clasp-test.json` | `.clasp-prod.json` |
| Backend deploy | `npm run push-test` (any branch) | `npm run push-prod` (clean `master` only) |
| Front-end deploy | push to `develop` → `/test/` | merge `develop` → `master` → root |
| `APP_ENV` Script Property | `test` | `prod` |
| Name on the phone | Finance TEST | Finance |

The guards that keep the two apart:

* **APP_ENV check**: the backend returns `APP_ENV` in `doGet` and in `session`. The phone knows its own environment from its URL (`/test/` is TEST). It refuses a backend of the other environment.
* **TEST banner**: the test app shows an orange TEST banner, so you always see which environment you are in.
* **Separate storage**: the test app keeps its settings under `fintrack.test.*` keys, so the two apps on one phone never share a URL or token.
* **Different tokens**: each environment has its own `API_TOKEN`. A TEST token does not open PROD.

The test sheet holds a copy of the real financial data, so it must stay private, the same as the real sheet. CC Sync in TEST reads the same Gmail as PROD, but writes only to the test sheet.

### What it does

The app has two tabs:

* **CC Tracker**: list and filter the credit card transactions, mark rows paid or cancelled, add notes, sync yesterday, today or a custom range, and clean up settled rows.
* **Financial**: a month home with totals per sheet, what remains, unpaid amounts by payment channel, jajan per person, the sheet's Dashboard panel, and sorting the ledgers.

Monthly Data editing and paid status (phase 2), Simulation (phase 3) and Generate Monthly Data (phase 4) come next. Generate and Rebuild Template stay sheet-only.

### How it talks to the sheet

The request path is: the PWA on GitHub Pages sends a `POST` with a `text/plain` body of JSON `{action, token, idToken}` to the Apps Script web app, which runs as the owner and reads or writes the spreadsheet.

| Action | Calls |
| --- | --- |
| `session` | Returns the signed-in email, `INCOME_PERSONS` and `currentMonthKey()`. |
| `month` | `getMonthlyEntryPayload` |
| `dashboard` | `readDashboard_` |
| `ccList` | `listCcTracker_` |
| `ccUpdate` | `updateCcTrackerRows_` |
| `ccSync` | `syncCcTransactions_` |
| `ccSettled` | `findCheckedItems_` |
| `ccDeleteSettled` | `deleteConfirmedRows` |
| `sortLedgers` | `sortLedgerSheets` |

### Security model

* Every request needs **both** the shared token (Script Property `API_TOKEN`) **and** a Google ID token whose email is in `ALLOWED_EMAILS`. The ID token is verified server-side against Google's tokeninfo endpoint: `aud` must equal `GOOGLE_CLIENT_ID`, the issuer must be Google, the email must be verified, and the token must not be expired. Verified results are cached until the token expires.
* 20 failed calls within 10 minutes lock the API for 10 minutes.
* Errors only say "Unauthorized". Tokens are never logged.
* Writes from the phone take the document lock and re-check each row's fingerprint and signature. A row changed in the sheet is skipped, never overwritten.
* Text written to cells is guarded against formula injection.
* The phone stores only the backend URL and the token. No financial data and no ID token are kept on the phone.
* The page runs under a strict Content-Security-Policy.
* The web app is deployed as **Execute as: Me, Who has access: Anyone**, because the browser calls it cross-origin. Access is enforced by the checks above, not by the deployment setting.

### One-time setup (owner)

Steps 4 to 6 are done in **both** projects: the real sheet's Apps Script project (PROD) and the test copy's (TEST).

1. **Google Cloud** (once, shared by both environments, because both use the same origin)
   * Create a new project.
   * APIs & Services → OAuth consent screen: user type External, publishing status Testing. Add both Google accounts as test users. Scopes: only `openid`, `email` and `profile`.
   * Credentials → Create OAuth client ID → Web application. Authorized JavaScript origin: `https://wivawilana67.github.io` (no path).
   * Copy the Client ID.
2. **Create the test copy of the sheet**
   * Open the real "Financial Tracker" sheet → File → Make a copy. Name the copy "Financial Tracker (TEST)".
   * Installable time-driven triggers are not copied. Do not add any to the test copy.
3. **Script IDs**
   * Real sheet → Extensions → Apps Script → Project Settings: copy the Script ID into `.clasp-prod.json` (copy `.clasp.example.json` to that name first).
   * Test copy → Extensions → Apps Script → Project Settings: copy the Script ID into `.clasp-test.json` (copy `.clasp.example.json` to that name first).
4. **Script Properties** (Project Settings → Script Properties), in each project. The values differ where noted:
   * `API_TOKEN`: generate a different token for each project with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   * `GOOGLE_CLIENT_ID`: the Client ID from step 1 (the same in both)
   * `ALLOWED_EMAILS`: comma-separated list of the allowed Google accounts (the same in both)
   * `SPREADSHEET_ID`: the ID of that project's own sheet, from its URL. The real sheet in PROD, the copy in TEST.
   * `APP_ENV`: `prod` in the real sheet's project, `test` in the copy's project.
5. **Push and authorize** (both projects)
   * From the repository root, run `npm run push-test`. In the test project's Apps Script editor, run `authorizeApi` once and accept the permissions.
   * From a clean `master` (merge `develop` first), run `npm run push-prod`. In the real project's Apps Script editor, run `authorizeApi` once and accept the permissions.
6. **Deployments** (both projects): Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. Keep each `/exec` URL in your password manager. Put both deployment IDs into `.deploy.json` (copy `.deploy.example.json` first), in this shape:
   ```json
   { "test": "<test deployment ID>", "prod": "<prod deployment ID>" }
   ```
7. **GitHub**
   * Settings → General → Default branch: `develop`.
   * Settings → Environments → github-pages → Deployment branches: allow `master` and `develop`. Without both, one of the two builds cannot deploy.
   * Settings → Pages → Source: GitHub Actions.
8. **On each phone**, sign in once per environment, then install:
   * TEST: open `https://wivawilana67.github.io/financial-tracker-system/test/`, enter the TEST `/exec` URL and the TEST token, then sign in with Google.
   * PROD: open `https://wivawilana67.github.io/financial-tracker-system/`, enter the PROD `/exec` URL and the PROD token, then sign in with Google.
   * Android: tap Install app. TEST installs as "Finance TEST", separate from "Finance".
   * iPhone: works in Safari. Optional: Share → Add to Home Screen. TEST is added as "Finance TEST", separate from "Finance".

### Deploy changes

* **Backend** (the root Apps Script files):
  * `npm run push-test` pushes the code to the TEST project and moves its web app deployment to a new version. Run it after every change, from any branch.
  * `npm run push-prod` does the same for the PROD project. Run it only on release, from a clean `master`.
  * The `/exec` URLs do not change.
* **Front end** (`web/`): push to `develop` and the "Deploy web to GitHub Pages" workflow publishes it to `/test/`. Merge `develop` into `master` and it publishes to the root. Both builds are one GitHub Pages site.
* **Pull a project back** into the local files: `npm run pull-test` or `npm run pull-prod`. Each copies that target's Script ID into `.clasp.json` and then runs `clasp pull`. This overwrites local files, so commit first.

## Development Workflow & Rules

1. **Two Environments**: TEST and PROD (see [Environments: TEST and PROD](#environments-test-and-prod)). Every development step lands on TEST first. PROD receives releases only. While developing, never run backend editor functions or pushes against PROD.
2. **Local Syncing** (needs `clasp` installed globally and `clasp login` done once). The Script IDs are in `.clasp-test.json` and `.clasp-prod.json`, which are **not committed**: copy `.clasp.example.json` to each name and paste that project's ID.
   * Pull the latest code from Google Apps Script (overwrites local files, so commit first):
     ```bash
     npm run pull-test
     npm run pull-prod
     ```
   * Push changes and update the web app deployment (see [Phone app (PWA)](#phone-app-pwa)). `.deploy.json` holds both deployment IDs and is also not committed. Without it only the code is pushed and a warning is printed:
     ```bash
     npm run push-test
     npm run push-prod
     ```
     `push-prod` runs only from a clean `master`.
3. **Automatic Deployment Requirement**: Every development step or code change **must always** be deployed to TEST immediately with `npm run push-test` (clasp push plus an update of the existing TEST web app deployment). PROD is deployed only on release, from a clean `master`, with `npm run push-prod`.
4. **Git Sync**: Before pushing code to remote git branches, make sure your local repository matches the Google Apps Script state and all modifications are staged/committed.
5. **Release Flow**:
   1. Commit and push straight to `develop` (no feature branches or worktrees unless explicitly wanted), and deploy with `npm run push-test`.
   2. Check the change in the TEST phone app (`/test/`).
   3. Open a PR from `develop` into `master` and merge it. This publishes the front end to the root of the Pages site.
   4. On a clean `master`, run `npm run push-prod`.
