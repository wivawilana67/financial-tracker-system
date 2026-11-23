"""Reads CSV exports of the Sheet tabs into model rows.

Columns are matched by header name, not position, so a re-ordered export still loads. The
header names are the ones the Sheet uses (README, "Ledger sheet contract"). A file is parsed
in full first; nothing is written unless the caller asks for it, and every bad row is reported
with its line number.
"""

import csv
import io
import logging
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import IO, Callable

from django.db import transaction

from .fingerprint import JAKARTA, cc_fingerprint
from .models import CcTransaction, IncomeEntry, LedgerEntry
from .money import parse_idr

log = logging.getLogger('fintrack.importers')

LEDGER_HEADERS = ('Date', 'List', 'Type', 'Amount', 'Note/Channel', 'Cicilan?',
                  'Payment Remaining', 'Sudah Bayar?')
INCOME_HEADERS = ('Date', 'Person', 'Category', 'Amount')
CC_HEADERS = ('Datetime', 'Bank', 'Card Number', 'Description', 'Type', 'Amount', 'Currency Code')

BATCH_SIZE = 500
_TRUE = {'true', 'yes', 'y', '1', 'ya', '✓'}
_FALSE = {'false', 'no', 'n', '0', 'tidak', ''}


@dataclass
class ImportReport:
    kind: str
    rows: list = field(default_factory=list)
    errors: list = field(default_factory=list)      # (line number, message)
    warnings: list = field(default_factory=list)    # (line number, message)
    skipped_duplicates: int = 0
    saved: int = 0
    replaced: int = 0

    def summary(self) -> str:
        return (f'{self.kind}: {len(self.rows)} rows ready, {len(self.errors)} errors, '
                f'{len(self.warnings)} warnings, {self.skipped_duplicates} duplicates skipped, '
                f'{self.replaced} replaced, {self.saved} saved')


def _require_headers(found, expected, kind):
    missing = [h for h in expected if h not in found]
    if missing:
        raise ValueError(f'{kind}: missing column(s) {", ".join(missing)}')


def parse_month(text: str):
    """Accepts 2026-11-01, 01/11/2026 or 01-11-2026. Returns (date, warning-or-None)."""
    value = (text or '').strip()
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y'):
        try:
            parsed = datetime.strptime(value, fmt).date()
        except ValueError:
            continue
        if parsed.day == 1:
            return parsed, None
        return parsed.replace(day=1), f'{value} is not the 1st; stored as {parsed:%Y-%m-01}'
    raise ValueError(f'unreadable month {text!r}')


def parse_flag(text: str) -> bool:
    value = (text or '').strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise ValueError(f'unreadable checkbox {text!r}')


def parse_remaining(text: str):
    value = (text or '').strip()
    if value == '':
        return None
    number = int(Decimal(value))
    if number < 0:
        raise ValueError(f'payments remaining cannot be negative: {text!r}')
    return number


def parse_datetime(text: str) -> datetime:
    """Accepts '2026-11-20 14:03:00' or the bank email style '20-11-2026 14:03:00'. Jakarta time."""
    value = (text or '').strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%d-%m-%Y %H:%M:%S', '%d/%m/%Y %H:%M:%S'):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=JAKARTA)
        except ValueError:
            continue
    raise ValueError(f'unreadable datetime {text!r}')


def _reader(source: IO[str] | str):
    stream = io.StringIO(source) if isinstance(source, str) else source
    reader = csv.DictReader(stream)
    if not reader.fieldnames:
        raise ValueError('the file has no header row')
    return reader, [name.strip() for name in reader.fieldnames]


def _each_row(reader, report: ImportReport, convert: Callable[[dict], object]):
    for line, raw in enumerate(reader, start=2):  # line 1 is the header
        cleaned = {(k or '').strip(): (v or '').strip() for k, v in raw.items()}
        if not any(cleaned.values()):
            continue
        try:
            row, warning = convert(cleaned)
        except (ValueError, ArithmeticError) as err:
            report.errors.append((line, str(err)))
            continue
        if warning:
            report.warnings.append((line, warning))
        report.rows.append(row)


def read_ledger_csv(source, ledger: str) -> ImportReport:
    report = ImportReport(kind=f'ledger:{ledger}')
    reader, found = _reader(source)
    _require_headers(found, LEDGER_HEADERS, report.kind)

    def convert(r):
        month, warning = parse_month(r['Date'])
        return LedgerEntry(
            ledger=ledger, month=month, list_name=r['List'], type_name=r['Type'],
            amount=parse_idr(r['Amount']), channel=r['Note/Channel'],
            is_installment=parse_flag(r['Cicilan?']),
            payments_remaining=parse_remaining(r['Payment Remaining']),
            paid=parse_flag(r['Sudah Bayar?']),
        ), warning

    _each_row(reader, report, convert)
    return report


def read_income_csv(source) -> ImportReport:
    report = ImportReport(kind='income')
    reader, found = _reader(source)
    _require_headers(found, INCOME_HEADERS, report.kind)

    def convert(r):
        month, warning = parse_month(r['Date'])
        return IncomeEntry(month=month, person=r['Person'], category=r['Category'],
                           amount=parse_idr(r['Amount'])), warning

    _each_row(reader, report, convert)
    return report


def read_cc_csv(source, inbox: str = 'imported') -> ImportReport:
    """CC Transaction tab. Duplicates (by fingerprint) are dropped, both within the file and in the database."""
    report = ImportReport(kind='cc-transaction')
    reader, found = _reader(source)
    _require_headers(found, CC_HEADERS, report.kind)

    def convert(r):
        when = parse_datetime(r['Datetime'])
        amount = parse_idr(r['Amount'])
        fingerprint = cc_fingerprint(when, r['Bank'], r['Card Number'], r['Description'],
                                     r['Type'], amount, r['Currency Code'])
        return CcTransaction(
            occurred_at=when, bank=r['Bank'], card_masked=r['Card Number'],
            description=r['Description'], type_name=r['Type'], amount=amount,
            currency=r['Currency Code'] or 'IDR', inbox=inbox, fingerprint=fingerprint,
        ), None

    _each_row(reader, report, convert)
    return report


def drop_known_cc_duplicates(report: ImportReport) -> None:
    """Removes rows already stored, and repeats inside the same file, from report.rows."""
    seen = set(CcTransaction.objects.values_list('fingerprint', flat=True))
    kept = []
    for row in report.rows:
        if row.fingerprint in seen:
            report.skipped_duplicates += 1
            continue
        seen.add(row.fingerprint)
        kept.append(row)
    report.rows = kept


def existing_rows_for(report: ImportReport):
    """Rows already stored for the months this ledger or income import would write."""
    if not report.rows or isinstance(report.rows[0], CcTransaction):
        return None
    model = type(report.rows[0])
    months = {row.month for row in report.rows}
    queryset = model.objects.filter(month__in=months)
    if model is LedgerEntry:
        queryset = queryset.filter(ledger=report.rows[0].ledger)
    return queryset


def save(report: ImportReport, replace: bool = False) -> ImportReport:
    """Writes the parsed rows in one transaction. Nothing is written if any row is bad or a batch fails.

    A ledger or income import refuses to run on months that already hold rows, so running the same
    file twice cannot double them. With replace=True those months are cleared first, in the same
    transaction, so a failed reload leaves the old rows in place.
    """
    if report.errors:
        raise ValueError(f'{report.kind} has {len(report.errors)} bad row(s); fix them first')
    if report.rows and isinstance(report.rows[0], CcTransaction):
        drop_known_cc_duplicates(report)
    if not report.rows:
        return report
    model = type(report.rows[0])
    with transaction.atomic():
        existing = existing_rows_for(report)
        if existing is not None and existing.exists():
            if not replace:
                raise ValueError(
                    f'{report.kind}: {existing.count()} row(s) already exist for these months. '
                    'Run again with --replace to clear those months and reload them.')
            report.replaced = existing.count()
            existing.delete()
        for start in range(0, len(report.rows), BATCH_SIZE):
            model.objects.bulk_create(report.rows[start:start + BATCH_SIZE], batch_size=BATCH_SIZE)
        report.saved = len(report.rows)
    log.info('import saved kind=%s rows=%s', report.kind, report.saved)
    return report
