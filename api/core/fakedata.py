"""Obviously fake sample data for dev and local testing. It is never used in prod.

Every name carries a "(sample)" marker or is plainly invented, so no sample row can be mistaken
for real finances. The output is deterministic for a given seed, which makes test runs repeatable.
"""

import random
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.conf import settings

from .fingerprint import JAKARTA, cc_fingerprint
from .models import CcTransaction, IncomeEntry, Ledger, LedgerEntry, Person

SAMPLE_LISTS = {
    Ledger.SAVING: ['Emergency fund (sample)', 'Holiday fund (sample)'],
    Ledger.EXPENSE: ['Groceries (sample)', 'Transport (sample)', 'Utilities (sample)',
                     'Dining out (sample)', 'Cicilan laptop (sample)'],
    Ledger.IBADAH: ['Charity (sample)'],
    Ledger.AUTODEDUCT: ['Jajan share (sample)'],
}
SAMPLE_CHANNELS = ['Sample Bank Debit', 'Sample Card', 'Sample E-wallet', 'Cash']
SAMPLE_MERCHANTS = ['SAMPLE MART', 'SAMPLE CAFE', 'SAMPLE FUEL', 'SAMPLE ONLINE SHOP', 'SAMPLE PHARMACY']
SAMPLE_CARDS = ['XXXX-XXXX-XXXX-1111', 'XXXX-XXXX-XXXX-2222']
SAMPLE_CATEGORIES = ['Salary (sample)', 'Bonus (sample)']


def _forbid_in_prod() -> None:
    if settings.APP_ENV == 'prod':
        raise RuntimeError('sample data is never written in prod')


def generate_month(month: date, rng: random.Random) -> dict:
    """Builds the rows for one month without saving them. Returns model instances grouped by kind."""
    ledger_rows = []
    for ledger, lists in SAMPLE_LISTS.items():
        for name in lists:
            count = 1 if ledger == Ledger.AUTODEDUCT else rng.randint(1, 3)
            for _ in range(count):
                amount = Decimal(rng.randint(20, 900) * 1000)
                installment = name.startswith('Cicilan')
                ledger_rows.append(LedgerEntry(
                    ledger=ledger, month=month, list_name=name,
                    type_name='Wiva' if ledger == Ledger.AUTODEDUCT else rng.choice(['Needs', 'Wants']),
                    amount=amount, channel=rng.choice(SAMPLE_CHANNELS),
                    is_installment=installment,
                    payments_remaining=rng.randint(1, 6) if installment else None,
                    paid=rng.random() < 0.5,
                ))
    income_rows = [
        IncomeEntry(month=month, person=person, category=category,
                    amount=Decimal(rng.randint(5, 30) * 100_000))
        for person in Person.values
        for category in SAMPLE_CATEGORIES
    ]
    cc_rows = []
    for _ in range(rng.randint(3, 8)):
        occurred = datetime(month.year, month.month, rng.randint(1, 28),
                            rng.randint(7, 22), rng.randint(0, 59), tzinfo=JAKARTA)
        bank, card = 'SAMPLE BANK', rng.choice(SAMPLE_CARDS)
        merchant = rng.choice(SAMPLE_MERCHANTS)
        amount = Decimal(rng.randint(10, 500) * 1000)
        cc_rows.append(CcTransaction(
            occurred_at=occurred, bank=bank, card_masked=card, description=merchant,
            type_name='Purchase', amount=amount, currency='IDR', inbox='sample',
            fingerprint=cc_fingerprint(occurred, bank, card, merchant, 'Purchase', amount, 'IDR'),
        ))
    return {'ledger': ledger_rows, 'income': income_rows, 'cc': cc_rows}


def seed(months: int, end: date, seed_value: int = 1) -> dict:
    """Creates `months` months of sample data ending with `end`'s month. Months that already have sample rows are skipped."""
    _forbid_in_prod()
    rng = random.Random(seed_value)
    created = {'ledger': 0, 'income': 0, 'cc': 0}
    month = end.replace(day=1)
    existing_cc = set(CcTransaction.objects.values_list('fingerprint', flat=True))
    for _ in range(months):
        if LedgerEntry.objects.filter(month=month, list_name__endswith='(sample)').exists():
            # Already seeded: skip, so running the command twice adds nothing.
            month = (month - timedelta(days=1)).replace(day=1)
            continue
        batch = generate_month(month, rng)
        LedgerEntry.objects.bulk_create(batch['ledger'])
        IncomeEntry.objects.bulk_create(batch['income'])
        fresh_cc = [r for r in batch['cc'] if r.fingerprint not in existing_cc]
        CcTransaction.objects.bulk_create(fresh_cc)
        existing_cc.update(r.fingerprint for r in fresh_cc)
        created['ledger'] += len(batch['ledger'])
        created['income'] += len(batch['income'])
        created['cc'] += len(fresh_cc)
        month = (month - timedelta(days=1)).replace(day=1)
    return created
