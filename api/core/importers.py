"""Reads CSV exports of the Sheet tabs into model rows.

Columns are matched by header name, not position, so a re-ordered export still loads. The headers
are the Sheet's own (the "live" layout checked on 2026-11-23). Where a tab's header has changed
over time, the older name is accepted too. A file is parsed in full first; nothing is written
unless the caller asks for it, and every bad row is reported with its line number.
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
from .models import CcTransaction, IncomeEntry, LedgerEntry, Person, WalletEntry
from .money import parse_idr

log = logging.getLogger('fintrack.importers')

BATCH_SIZE = 500
WALLET_HEADER_ROW = 15  # Blu Balance keeps its summary above the table; the table header is row 15.
WALLET_TICKS = 24
_TRUE = {'true', 'yes', 'y', '1', 'ya', '✓'}
_FALSE = {'false', 'no', 'n', '0', 'tidak', ''}

# Each entry lists the names a column may have. The first name present in the file is used.
LEDGER_COLUMNS = {
    'date': ('Month', 'Date'),
    'list': ('List',),
    'type': ('Type', 'Who?'),           # Autodeduct Jajan calls this column "Who?"
    'amount': ('Amount',),
    'channel': ('Payment Channel', 'Note/Channel'),
    'installment': ('Cicilan?',),
    'remaining': ('Payment Remaining',),
    'paid': ('Sudah Bayar?',),
}
INCOME_COLUMNS = {
    'date': ('Month', 'Date'),
    'person': ('List', 'Person'),       # the person is in column B
    'category': ('Type', 'Category'),   # the category is in column C
    'amount': ('Amount',),
}
CC_COLUMNS = {
    'datetime': ('Datetime',),
    'bank': ('Bank',),
    'card': ('Card Number',),
    'description': ('Description',),
    'type': ('Type',),
    'amount': ('Amount',),
    'currency': ('Currency Code',),
}
WALLET_COLUMNS = {
    'date': ('Date',),
    'list': ('List Usage',),
    'price': ('Price',),
    'account': ('Account',),
    'income': ('Income?',),
    'paid': ('Sudah Bayar?',),
    'cicil': ('Cicil / Not',),
    'months': ('Bulan',),
}


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


class _Columns:
    """Resolves each logical column to the header name the file actually uses."""

    def __init__(self, found, mapping: dict, kind: str):
        self.names = {}
        missing = []
        for key, options in mapping.items():
            name = next((o for o in options if o in found), None)
            if name is None:
                missing.append(' / '.join(options))
            else:
                self.names[key] = name
        if missing:
            raise ValueError(f'{kind}: missing column(s) {", ".join(missing)}')

    def __call__(self, row: dict, key: str) -> str:
        return row.get(self.names[key], '')


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


def _reader(source: IO[str] | str, header_row: int = 1):
    """Returns a DictReader whose header is on `header_row` (1-based); rows above it are skipped."""
    text = source if isinstance(source, str) else source.read()
    lines = text.splitlines(keepends=True)[header_row - 1:]
    reader = csv.DictReader(io.StringIO(''.join(lines)))
    if not reader.fieldnames:
        raise ValueError('the file has no header row')
    return reader, [(name or '').strip() for name in reader.fieldnames]


def _each_row(reader, report: ImportReport, convert: Callable[[dict], tuple], header_row: int = 1):
    """Converts each data row. Line numbers are the file's own line numbers, counted from the top."""
    for line, raw in enumerate(reader, start=header_row + 1):
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
    cols = _Columns(found, LEDGER_COLUMNS, report.kind)

    def convert(r):
        month, warning = parse_month(cols(r, 'date'))
        return LedgerEntry(
            ledger=ledger, month=month, list_name=cols(r, 'list'), type_name=cols(r, 'type'),
            amount=parse_idr(cols(r, 'amount')), channel=cols(r, 'channel'),
            is_installment=parse_flag(cols(r, 'installment')),
            payments_remaining=parse_remaining(cols(r, 'remaining')),
            paid=parse_flag(cols(r, 'paid')),
        ), warning

    _each_row(reader, report, convert)
    return report


def read_income_csv(source) -> ImportReport:
    report = ImportReport(kind='income')
    reader, found = _reader(source)
    cols = _Columns(found, INCOME_COLUMNS, report.kind)

    def convert(r):
        month, warning = parse_month(cols(r, 'date'))
        person = cols(r, 'person')
        if person not in Person.values:
            raise ValueError(f'unknown person {person!r}; expected one of {", ".join(Person.values)}')
        return IncomeEntry(month=month, person=person, category=cols(r, 'category'),
                           amount=parse_idr(cols(r, 'amount'))), warning

    _each_row(reader, report, convert)
    return report


def read_cc_csv(source, inbox: str = 'imported') -> ImportReport:
    """CC Transaction tab. Duplicates (by fingerprint) are dropped, both within the file and in the database."""
    report = ImportReport(kind='cc-transaction')
    reader, found = _reader(source)
    cols = _Columns(found, CC_COLUMNS, report.kind)

    def convert(r):
        when = parse_datetime(cols(r, 'datetime'))
        amount = parse_idr(cols(r, 'amount'))
        bank, card = cols(r, 'bank'), cols(r, 'card')
        description, type_name = cols(r, 'description'), cols(r, 'type')
        currency = cols(r, 'currency') or 'IDR'
        return CcTransaction(
            occurred_at=when, bank=bank, card_masked=card, description=description,
            type_name=type_name, amount=amount, currency=currency, inbox=inbox,
            fingerprint=cc_fingerprint(when, bank, card, description, type_name, amount, currency),
        ), None

    _each_row(reader, report, convert)
    return report


def read_wallet_csv(source) -> ImportReport:
    """Blu Balance tab. The file starts at the top of the tab; the table header is on row 15."""
    report = ImportReport(kind='wallet')
    reader, found = _reader(source, header_row=WALLET_HEADER_ROW)
    cols = _Columns(found, WALLET_COLUMNS, report.kind)
    tick_names = [str(n) for n in range(1, WALLET_TICKS + 1)]
    missing_ticks = [n for n in tick_names if n not in found]
    if missing_ticks:
        raise ValueError(f'{report.kind}: missing installment column(s) {", ".join(missing_ticks)}')

    def convert(r):
        date_text = cols(r, 'date')
        when, warning = (None, None)
        if date_text:
            when, warning = parse_month_or_day(date_text)
        months = cols(r, 'months')
        return WalletEntry(
            date=when, list_usage=cols(r, 'list'), price=parse_idr(cols(r, 'price')),
            account=cols(r, 'account'), is_income=parse_flag(cols(r, 'income')),
            paid=parse_flag(cols(r, 'paid')), is_installment=cols(r, 'cicil').lower() == 'cicil',
            months_total=int(Decimal(months)) if months else None,
            ticks=[parse_flag(r.get(n, '')) for n in tick_names],
        ), warning

    _each_row(reader, report, convert, header_row=WALLET_HEADER_ROW)
    return report


def parse_month_or_day(text: str):
    """Wallet dates are real days, not month starts. Accepts the same formats as parse_month."""
    value = (text or '').strip()
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y'):
        try:
            return datetime.strptime(value, fmt).date(), None
        except ValueError:
            continue
    raise ValueError(f'unreadable date {text!r}')


def existing_rows_for(report: ImportReport):
    """Rows already stored for the months this ledger or income import would write."""
    if not report.rows or not isinstance(report.rows[0], (LedgerEntry, IncomeEntry)):
        return None  # card rows are deduplicated; wallet rows use the whole-table check in save()
    model = type(report.rows[0])
    months = {row.month for row in report.rows}
    queryset = model.objects.filter(month__in=months)
    if model is LedgerEntry:
        queryset = queryset.filter(ledger=report.rows[0].ledger)
    return queryset


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


def save(report: ImportReport, replace: bool = False) -> ImportReport:
    """Writes the parsed rows in one transaction. Nothing is written if any row is bad or a batch fails.

    Ledger and income imports refuse months that already hold rows, so running the same file twice
    cannot double them. With replace=True those months are cleared first, in the same transaction,
    so a failed reload leaves the old rows in place. Wallet rows are not deduplicated: the Wallet
    tab is loaded once, during the migration, with the rest of the data.
    """
    if report.errors:
        raise ValueError(f'{report.kind} has {len(report.errors)} bad row(s); fix them first')
    if report.rows and isinstance(report.rows[0], CcTransaction):
        drop_known_cc_duplicates(report)
    if not report.rows:
        return report
    model = type(report.rows[0])
    with transaction.atomic():
        existing = WalletEntry.objects.all() if model is WalletEntry else existing_rows_for(report)
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
    log.info('import saved kind=%s rows=%s replaced=%s', report.kind, report.saved, report.replaced)
    return report
