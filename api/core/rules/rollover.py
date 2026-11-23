"""Monthly rollover: candidates from last month, the upsert into the target month, and the jajan budget.

Port of MonthlyGeneration.js (README, "Generate Monthly Data flow"). Pure functions only; the
database layer loads rows and saves the result (core/rollover.py).

Identity rules, as in the Sheet:
- A ledger row's identity is List + Type + Channel. The Income tab has no channel: its identity is
  List + Type (person + category).
- Candidates come from two passes. Pass 1: the latest state of each active installment, from any
  month before the target. Pass 2: plain rows from the source month that no installment covers.
- The Expense tab's jajan rows (Type = "Jajan") are never candidates; they are recalculated.
- The merge is an upsert: a match in the target month is updated in place (amount, installment
  flags, paid), otherwise the row is appended. Each target row is claimed at most once.
"""

from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal

from .installments import InstallmentState, is_more_recent
from .jajan import JajanInput, allocate

EXPENSE = 'expense'
AUTODEDUCT = 'autodeduct'
INCOME = 'income'
JAJAN_TYPE = 'jajan'
OWNERS = {'wiva': 'Wiva', 'rio': 'Wiva', 'jane': 'Jane'}


@dataclass(frozen=True)
class Row:
    ledger: str
    month: date
    list_name: str
    type_name: str
    amount: Decimal
    channel: str = ''
    is_installment: bool = False
    remaining: int | None = None
    paid: bool = False

    @property
    def identity(self) -> tuple:
        return (self.list_name, self.type_name, self.channel)

    @property
    def uid(self) -> str:
        """Stable id the dialog uses to select a candidate: ledger + identity."""
        return '|'.join((self.ledger, *self.identity))


def is_jajan(type_name: str) -> bool:
    return (type_name or '').strip().lower() == JAJAN_TYPE


def _skipped(row: Row, ledger: str) -> bool:
    return ledger == EXPENSE and is_jajan(row.type_name)


def collect_candidates(rows: list[Row], ledger: str, source: date, target: date) -> list[Row]:
    """The source rows to carry into `target`, in the order the Sheet lists them."""
    latest: dict[tuple, tuple[Row, InstallmentState]] = {}
    for row in rows:
        if row.ledger != ledger or not row.is_installment or row.month >= target:
            continue
        if _skipped(row, ledger) or row.remaining is None:
            continue
        state = InstallmentState(key=row.identity, month=row.month, remaining=row.remaining, amount=row.amount)
        current = latest.get(row.identity)
        if current is None or is_more_recent(state, current[1]):
            # dict keeps the first position, like the Sheet's order array
            latest[row.identity] = (row, state)

    candidates: list[Row] = []
    claimed: set[tuple] = set()
    for identity, (row, state) in latest.items():
        if state.remaining <= 1:
            continue  # finished
        candidates.append(row)
        claimed.add(identity)

    for row in rows:
        if row.ledger != ledger or row.month != source or row.is_installment:
            continue
        if _skipped(row, ledger) or row.identity in claimed:
            continue
        candidates.append(row)
    return candidates


def to_target_row(source: Row, target: date, amount: Decimal) -> Row:
    """The row written for `target`. An installment burns one payment; the paid tick is reset."""
    remaining = source.remaining - 1 if source.is_installment else None
    return Row(ledger=source.ledger, month=target, list_name=source.list_name, type_name=source.type_name,
               amount=amount, channel=source.channel, is_installment=source.is_installment,
               remaining=remaining, paid=False)


def resolve_amount(row: Row, overrides: dict[str, Decimal]) -> Decimal:
    return overrides.get(row.uid, row.amount)


@dataclass
class MergeResult:
    rows: list[Row]                       # the target month after the merge, in order
    updated: list[int] = field(default_factory=list)   # indexes into rows that were updated
    inserted: list[Row] = field(default_factory=list)


def merge(existing: list[Row], incoming: list[Row], ledger: str) -> MergeResult:
    """Upserts `incoming` into `existing` (both for one month and one ledger)."""
    is_income = ledger == INCOME
    index: dict[tuple, list[int]] = defaultdict(list)
    for i, row in enumerate(existing):
        key = (row.list_name, row.type_name) if is_income else row.identity
        index[key].append(i)

    rows = list(existing)
    result = MergeResult(rows=rows)
    for new in incoming:
        key = (new.list_name, new.type_name) if is_income else new.identity
        queue = index.get(key)
        if queue:
            i = queue.pop(0)
            current = rows[i]
            if is_income:
                rows[i] = replace(current, amount=new.amount)
            else:
                rows[i] = replace(current, amount=new.amount, is_installment=new.is_installment,
                                  remaining=new.remaining, paid=new.paid)
            result.updated.append(i)
        else:
            result.inserted.append(new)
    rows.extend(result.inserted)
    return result


def autodeduct_totals(planned: list[Row], existing: list[Row]) -> dict[str, Decimal]:
    """Each person's autodeduction total for the month after this run.

    A planned row replaces one existing row with the same identity, so that existing row is not
    counted again. Owners other than Wiva/Rio or Jane count towards nobody.
    """
    claimed: dict[tuple, list[Row]] = defaultdict(list)
    for row in existing:
        claimed[row.identity].append(row)
    totals = {'Wiva': Decimal(0), 'Jane': Decimal(0)}

    def add(owner_text: str, amount: Decimal) -> None:
        if amount <= 0:
            return
        owner = OWNERS.get((owner_text or '').strip().lower())
        if owner:
            totals[owner] += amount

    for row in planned:
        queue = claimed.get(row.identity)
        if queue:
            queue.pop(0)
        add(row.type_name, row.amount)
    for rows in claimed.values():
        for row in rows:
            add(row.type_name, row.amount)
    return totals


def jajan_rows(target: date, wiva_net: Decimal, jane_net: Decimal, wiva_channel: str, jane_channel: str) -> list[Row]:
    """The two recalculated Jajan rows on the Expense tab: List = person, Type = "Jajan"."""
    return [
        Row(EXPENSE, target, 'Wiva', 'Jajan', wiva_net, wiva_channel),
        Row(EXPENSE, target, 'Jane', 'Jajan', jane_net, jane_channel),
    ]


def jajan_net(base: dict[str, Decimal], rates: JajanInput, autodeduct: dict[str, Decimal]) -> tuple[Decimal, Decimal]:
    """Wiva's and Jane's net jajan for the month."""
    inputs = JajanInput(base['Wiva'], base['Jane'], rates.pool_rate, rates.wiva_rate, rates.jane_rate)
    result = allocate(inputs, autodeduct['Wiva'], autodeduct['Jane'])
    return result.wiva_net, result.jane_net
