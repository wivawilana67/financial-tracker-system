"""Installment (cicilan) rollover: which rows carry into the target month, and how many payments are left.

Port of the candidate scan in MonthlyGeneration.js (README, "Installments (Cicilan)").

- Only rows dated strictly before the target month are read. Rows already written for the target
  month never count, so a re-run can't take off a payment twice.
- For each item (List + Type + Channel) the most recent state before the target month is used.
  "Most recent" means the latest month. Two rows in the same month are a data slip, and the one
  with fewer payments left wins.
- An installment with 1 payment or fewer left is finished and is not carried.
- The carried row has one payment less than its source row.
"""

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class InstallmentState:
    key: tuple          # (list, type, channel)
    month: date         # first day of the source month
    remaining: int      # payments left in that month
    amount: object      # the amount as written that month (Decimal)


def is_more_recent(candidate: InstallmentState, current: InstallmentState) -> bool:
    """Port of isMoreRecentState_(): later month wins; in the same month, fewer payments left wins."""
    if candidate.month != current.month:
        return candidate.month > current.month
    return candidate.remaining < current.remaining


def latest_states(rows: list[InstallmentState], target_month: date) -> dict:
    """The latest state of each installment strictly before target_month."""
    latest: dict[tuple, InstallmentState] = {}
    for row in rows:
        if row.month >= target_month:
            continue
        current = latest.get(row.key)
        if current is None or is_more_recent(row, current):
            latest[row.key] = row
    return latest


def carry_forward(rows: list[InstallmentState], target_month: date) -> dict:
    """Maps each active installment to the remaining count it carries into target_month."""
    carried = {}
    for key, state in latest_states(rows, target_month).items():
        if state.remaining <= 1:
            continue  # finished: its last payment is already booked
        carried[key] = state.remaining - 1
    return carried
