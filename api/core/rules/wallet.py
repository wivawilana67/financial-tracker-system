"""Blu Balance rules, ported from buildBluBalanceSheet_ in TemplateGenerator.js.

Column meanings (the Sheet's own): C price, D account, E income?, F sudah bayar?, G cicil / not,
H bulan, M..AJ the 24 installment ticks. J ("Sudah Bayar Cicilan") is the monthly instalment times the
ticks taken so far: J = (C / H) x ticks, for cicilan rows only.

The account balance formula (B6 in the template) is kept exactly as the Sheet has it:
  + price where income and paid          (for this account)
  - price where expense and paid
  + price where cicil and paid
  - J                                    (instalments paid so far)
The "+ cicil and paid" term is a parity port: check it against the Sheet during the trial import.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal


@dataclass(frozen=True)
class WalletRow:
    price: Decimal
    account: str
    is_income: bool
    paid: bool
    is_installment: bool
    months_total: int | None
    ticks: tuple


def monthly_instalment(row: WalletRow) -> Decimal:
    """C / H for cicilan rows, rounded to whole rupiah for display; zero otherwise."""
    if not row.is_installment or not row.months_total:
        return Decimal(0)
    return (row.price / Decimal(row.months_total)).quantize(Decimal('1'), rounding=ROUND_HALF_UP)


def instalments_paid(row: WalletRow) -> Decimal:
    """J: the instalment times the ticks taken so far (cicilan rows only)."""
    if not row.is_installment or not row.months_total:
        return Decimal(0)
    return (row.price / Decimal(row.months_total)) * Decimal(sum(1 for t in row.ticks if t))


def account_balance(rows: list[WalletRow], account: str) -> Decimal:
    """Remaining balance of one account (B6 in the template)."""
    mine = [r for r in rows if r.account == account]
    income_paid = sum((r.price for r in mine if r.is_income and r.paid), Decimal(0))
    expense_paid = sum((r.price for r in mine if not r.is_income and r.paid), Decimal(0))
    cicil_paid = sum((r.price for r in mine if r.is_installment and r.paid), Decimal(0))
    instalments = sum((instalments_paid(r) for r in mine), Decimal(0))
    return income_paid - expense_paid + cicil_paid - instalments


def total_wallet(rows: list[WalletRow]) -> Decimal:
    """B1: all income that is marked paid."""
    return sum((r.price for r in rows if r.is_income and r.paid), Decimal(0))
