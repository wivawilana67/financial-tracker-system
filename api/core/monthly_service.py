"""Monthly Data edits, paid marks and the dashboard, on the database.

Every write is one transaction. A row changed by someone else since it was loaded is skipped and
reported, never overwritten (the version check, as in FinancialSystem.js's signature guard).
"""

import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from .models import IncomeEntry, LedgerEntry
from .rules import monthly as mr

log = logging.getLogger('fintrack.monthly')
LEDGER_NAMES = {'saving', 'expense', 'ibadah', 'autodeduct'}


@dataclass
class LedgerUpdate:
    id: int
    version: int
    amount: Decimal
    channel: str | None = None            # None: change the amount only
    is_installment: bool = False
    remaining: int | None = None
    paid: bool = False


@dataclass
class LedgerDeletion:
    id: int
    version: int


@dataclass
class LedgerAddition:
    ledger: str
    list_name: str
    type_name: str
    amount: Decimal
    channel: str = ''
    is_installment: bool = False
    remaining: int | None = None
    paid: bool = False


@dataclass
class ChangeSet:
    month: date
    updates: list = field(default_factory=list)
    deletions: list = field(default_factory=list)
    additions: list = field(default_factory=list)
    income_updates: list = field(default_factory=list)   # (id, version, amount)


def _check_month(month: date) -> None:
    if month.day != 1:
        raise ValueError('month must be the first day of the month')


def _check_ledger_fields(amount, is_installment, remaining, ledger=None) -> None:
    if amount is None or amount < 0:
        raise ValueError('amount must be zero or more')
    if remaining is not None and not is_installment:
        raise ValueError('a remaining count needs the cicilan flag')
    if is_installment and remaining is not None and remaining < 0:
        raise ValueError('payments remaining cannot be negative')
    if ledger is not None and ledger not in LEDGER_NAMES:
        raise ValueError(f'unknown ledger {ledger!r}')


def apply_changes(change: ChangeSet) -> dict:
    """Writes the edits, deletions and additions for one month, and moves the jajan rows to match."""
    _check_month(change.month)
    result = {'updated': 0, 'deleted': 0, 'added': 0, 'skipped': [], 'jajan_adjusted': []}
    events: list[mr.JajanEvent] = []

    with transaction.atomic():
        for upd in change.updates:
            _check_ledger_fields(upd.amount, upd.is_installment, upd.remaining)
            row = LedgerEntry.objects.select_for_update().filter(id=upd.id, month=change.month).first()
            if row is None or row.version != upd.version:
                result['skipped'].append(f'row {upd.id}: changed since it was loaded')
                continue
            events += mr.edit_events(row.ledger, row.amount, upd.amount, row.type_name)
            row.amount = upd.amount
            if upd.channel is not None:
                row.channel = upd.channel
                row.is_installment = upd.is_installment
                row.payments_remaining = upd.remaining
                row.paid = upd.paid
            row.version += 1
            row.save()
            result['updated'] += 1

        for dele in change.deletions:
            row = LedgerEntry.objects.select_for_update().filter(id=dele.id, month=change.month).first()
            if row is None or row.version != dele.version:
                result['skipped'].append(f'row {dele.id}: changed since it was loaded')
                continue
            events += mr.edit_events(row.ledger, row.amount, None, row.type_name)
            row.delete()
            result['deleted'] += 1

        for add in change.additions:
            _check_ledger_fields(add.amount, add.is_installment, add.remaining, add.ledger)
            LedgerEntry.objects.create(
                ledger=add.ledger, month=change.month, list_name=add.list_name, type_name=add.type_name,
                amount=add.amount, channel=add.channel, is_installment=add.is_installment,
                payments_remaining=add.remaining, paid=add.paid)
            events += mr.edit_events(add.ledger, None, add.amount, add.type_name)
            result['added'] += 1

        for income_id, version, amount in change.income_updates:
            if amount is None or amount < 0:
                raise ValueError('income amount must be zero or more')
            row = IncomeEntry.objects.select_for_update().filter(id=income_id, month=change.month).first()
            if row is None or row.version != version:
                result['skipped'].append(f'income {income_id}: changed since it was loaded')
                continue
            row.amount = amount
            row.version += 1
            row.save()
            result['updated'] += 1

        jajan_rows = {
            mr.owner_of(m.list_name): m for m in LedgerEntry.objects.select_for_update().filter(
                month=change.month, ledger=mr.EXPENSE, type_name__iexact=mr.JAJAN)
            if mr.owner_of(m.list_name)}
        jajan_before = {owner: jajan_rows[owner].amount for owner in jajan_rows}
        new_amounts, notes = mr.apply_jajan_events(events, jajan_before)
        for owner, amount in new_amounts.items():
            row = jajan_rows[owner]
            result['jajan_adjusted'].append(f'{owner}: {row.amount} -> {amount}')
            row.amount = amount
            row.version += 1
            row.save()
        result['skipped'] += notes
    log.info('monthly changes applied month=%s updated=%s deleted=%s added=%s skipped=%s',
             change.month, result['updated'], result['deleted'], result['added'], len(result['skipped']))
    return result


def mark_paid(month: date, channels: set, events: set) -> int:
    """Ticks Sudah Bayar? on the unpaid rows picked by channel or by row. Returns how many were marked."""
    _check_month(month)
    rows = list(LedgerEntry.objects.filter(month=month, ledger__in=LEDGER_NAMES))
    ids = [row.id for row in mr.rows_to_mark_paid(rows, channels, events)]
    if ids:
        LedgerEntry.objects.filter(id__in=ids).update(paid=True)
    return len(ids)


def dashboard_for(month: date) -> dict:
    """Totals per ledger and the remaining amounts for the month."""
    _check_month(month)
    income_total = IncomeEntry.objects.filter(month=month).aggregate(s=Sum('amount'))['s'] or Decimal(0)
    rows = LedgerEntry.objects.filter(month=month)
    totals = {}
    for ledger in ('saving', 'expense', 'ibadah'):
        if ledger == 'expense':
            totals[ledger] = rows.filter(ledger=ledger).exclude(type_name__iexact=mr.JAJAN).aggregate(
                s=Sum('amount'))['s'] or Decimal(0)
        else:
            totals[ledger] = rows.filter(ledger=ledger).aggregate(s=Sum('amount'))['s'] or Decimal(0)
    autodeduct = rows.filter(ledger='autodeduct')
    auto_total = autodeduct.aggregate(s=Sum('amount'))['s'] or Decimal(0)
    realized = autodeduct.filter(paid=True).aggregate(s=Sum('amount'))['s'] or Decimal(0)
    return mr.dashboard(income_total, totals, auto_total, realized)
