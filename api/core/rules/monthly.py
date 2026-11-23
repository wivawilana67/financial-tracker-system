"""Monthly Data edits, paid status, simulation and dashboard totals.

Port of FinancialSystem.js, PaidStatus.js, Simulation.js and the Dashboard formulas in
TemplateGenerator.js. Pure functions; the database layer lives in core/monthly_service.py.

Dashboard formulas marked INFERRED were read from the Sheet's cell formulas, not from a tested
export. They are checked against the real Sheet during the trial import (phase 7).
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from .jajan import JajanInput, allocate

HUNDRED = Decimal(100)
AUTODEDUCT = 'autodeduct'
EXPENSE = 'expense'
JAJAN = 'jajan'
OWNERS = {'wiva': 'Wiva', 'rio': 'Wiva', 'jane': 'Jane'}
# Budget shares of income for each ledger, from buildDashboardCards_ in TemplateGenerator.js.
TARGET_SHARES = {'saving': Decimal('0.4'), 'expense': Decimal('0.5'), 'ibadah': Decimal('0.1')}


def owner_of(text: str) -> str:
    """'Wiva' or 'Jane' from an owner cell, or '' when it names neither (such rows count for nobody)."""
    return OWNERS.get((text or '').strip().lower(), '')


# --- Monthly Data edits --------------------------------------------------------

@dataclass(frozen=True)
class JajanEvent:
    """One change that moves a person's autodeduction. The sign is the change in what is taken out."""
    owner: str
    delta: Decimal


def edit_events(ledger: str, before: Decimal | None, after: Decimal | None, owner_text: str) -> list:
    """Autodeduct edits move the jajan budget by the same amount (FinancialSystem.js, applySheetChanges_).

    An update contributes new minus old; an addition contributes its amount; a deletion contributes minus
    its amount. `before` is None for an addition, `after` is None for a deletion.
    """
    if ledger != AUTODEDUCT:
        return []
    owner = owner_of(owner_text)
    if not owner:
        return []
    old = before or Decimal(0)
    new = after or Decimal(0)
    delta = new - old
    return [JajanEvent(owner, delta)] if delta != 0 else []


def apply_jajan_events(events: list, jajan_before: dict) -> tuple[dict, list]:
    """Moves each owner's Expense Jajan row by their total delta.

    `jajan_before` maps an owner to that month's Jajan amount, or is missing when there is no row.
    Returns (new amount per owner, notes for owners who had no Jajan row to change). A row is never
    created here: a budget with no gross share behind it would be negative.
    """
    totals: dict[str, Decimal] = {}
    for event in events:
        totals[event.owner] = totals.get(event.owner, Decimal(0)) + event.delta
    new_amounts: dict[str, Decimal] = {}
    notes: list[str] = []
    for owner, delta in totals.items():
        if delta == 0:
            continue
        if owner not in jajan_before:
            notes.append(f'No Expense / Jajan row for {owner} this month, so the autodeduct change was not taken off any budget')
            continue
        new_amounts[owner] = max(Decimal(0), jajan_before[owner] - delta)
    return new_amounts, notes


# --- paid status ---------------------------------------------------------------

def _key(*parts) -> tuple:
    return tuple((p or '').strip().lower() for p in parts)


def rows_to_mark_paid(rows: list, channels: set, events: set) -> list:
    """Unpaid rows of the ticked channels, or whose List + Type + Channel was ticked.

    `rows` are objects with list_name, type_name, channel and paid. Matching ignores case and
    surrounding spaces, as PaidStatus.js does. Rows already paid are left as they are.
    """
    channel_keys = {_key(c)[0] for c in channels if c}
    event_keys = {_key(*e) for e in events}
    picked = []
    for row in rows:
        if row.paid:
            continue
        if _key(row.channel)[0] in channel_keys or _key(row.list_name, row.type_name, row.channel) in event_keys:
            picked.append(row)
    return picked


# --- simulation -------------------------------------------------------------------

def simulated_remaining(income: Decimal, saving: Decimal, expense_without_jajan: Decimal,
                        jajan_net: Decimal, ibadah: Decimal, autodeduct: Decimal) -> Decimal:
    """Remaining = income - saving - expense - jajan (net) - ibadah - autodeduct (Simulation.js).

    The Expense Jajan rows hold the net budget, so the caller passes Expense without them and the
    net jajan separately.
    """
    return income - saving - expense_without_jajan - jajan_net - ibadah - autodeduct


def simulated_jajan_net(baseline_net: dict, gross_delta: dict, auto_delta: dict) -> dict:
    """Net jajan moves by changes from the baseline: net = baseline net + change in gross - change in autodeduct.

    Never below zero. Gross = net + autodeduction, so the two never count the same money twice.
    """
    result = {}
    for owner in ('Wiva', 'Jane'):
        net = baseline_net[owner] + gross_delta.get(owner, Decimal(0)) - auto_delta.get(owner, Decimal(0))
        result[owner] = max(Decimal(0), net)
    return result


def default_jajan(base: Decimal, rates: JajanInput, autodeduct: dict) -> dict:
    """The Generate defaults: pool and split from the rates, used when the month has no Jajan rows yet."""
    inputs = JajanInput(base, Decimal(0), rates.pool_rate, rates.wiva_rate, rates.jane_rate)
    result = allocate(inputs, autodeduct['Wiva'], autodeduct['Jane'])
    return {'Wiva': result.wiva_net, 'Jane': result.jane_net}


# --- dashboard ------------------------------------------------------------------

def _pct(part: Decimal, whole: Decimal) -> Decimal:
    return Decimal(0) if whole == 0 else (part / whole * HUNDRED).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class LedgerSummary:
    ledger: str
    total: Decimal
    percent_of_income: Decimal
    target: Decimal
    to_target_percent: Decimal


def dashboard(income_total: Decimal, totals: dict, autodeduct_total: Decimal, realized_autodeduct: Decimal) -> dict:
    """Totals, shares and remaining amounts for the Dashboard.

    INFERRED from the Sheet's formulas (TemplateGenerator.js, buildDashboardIncome_ and buildDashboardCards_):
    - Target = share x income; "to target %" = total / income.
    - Expected remaining = income - total deduction (every autodeduction in the month).
    - Current remaining = income - realized deduction (only the autodeductions marked as taken).
    """
    summaries = []
    for ledger, share in TARGET_SHARES.items():
        total = totals.get(ledger, Decimal(0))
        summaries.append(LedgerSummary(
            ledger=ledger,
            total=total,
            percent_of_income=_pct(total, income_total),
            target=(share * income_total).quantize(Decimal('1'), rounding=ROUND_HALF_UP),
            to_target_percent=_pct(total, income_total),
        ))
    return {
        'income': income_total,
        'ledgers': summaries,
        'expected_remaining': income_total - autodeduct_total,
        'current_remaining': income_total - realized_autodeduct,
    }
