"""Phase 2: money parsing, the duplicate key, the Sheet importers, model rules, sample data and admin."""

import io
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction

from core import fakedata, importers
from core.fingerprint import KEY_SEPARATOR, cc_fingerprint
from core.models import CcTransaction, IncomeEntry, Ledger, LedgerEntry
from core.money import parse_idr

JAKARTA = ZoneInfo('Asia/Jakarta')

LEDGER_CSV_HEADER = 'Date,List,Type,Amount,Note/Channel,Cicilan?,Payment Remaining,Sudah Bayar?\n'
INCOME_CSV_HEADER = 'Date,Person,Category,Amount\n'
CC_CSV_HEADER = 'Datetime,Bank,Card Number,Description,Type,Amount,Currency Code\n'


# --- money -----------------------------------------------------------------

@pytest.mark.parametrize('text, expected', [
    ('120.000', '120000.00'),        # Indonesian locale
    ('1.250.000', '1250000.00'),
    ('120,000', '120000.00'),        # English locale
    ('Rp 15.500', '15500.00'),
    ('120000.5', '120000.50'),       # plain number with decimal point
    ('1.5', '1.50'),
    ('-40.000', '-40000.00'),
])
def test_parse_idr_reads_both_locales(text, expected):
    assert parse_idr(text) == Decimal(expected)


@pytest.mark.parametrize('text', ['', '   ', 'abc', 'NaN', None])
def test_parse_idr_rejects_non_amounts(text):
    with pytest.raises(ValueError):
        parse_idr(text)


# --- fingerprint -----------------------------------------------------------

def test_fingerprint_matches_the_apps_script_key_layout():
    when = datetime(2026, 11, 20, 14, 3, 0, tzinfo=JAKARTA)
    expected_key = KEY_SEPARATOR.join([
        '2026-11-20 14:03:00', 'BCA', 'XXXX-1111', 'SAMPLE MART', 'Purchase', '120000', 'IDR',
    ])
    import hashlib
    assert cc_fingerprint(when, 'BCA', 'XXXX-1111', 'SAMPLE MART', 'Purchase',
                          Decimal('120000.00'), 'IDR') == hashlib.sha256(expected_key.encode()).hexdigest()


def test_fingerprint_ignores_time_zone_of_the_input():
    jakarta = datetime(2026, 11, 20, 14, 3, 0, tzinfo=JAKARTA)
    utc = jakarta.astimezone(ZoneInfo('UTC'))
    args = ('BCA', 'XXXX-1111', 'SAMPLE MART', 'Purchase', Decimal('120000'), 'IDR')
    assert cc_fingerprint(jakarta, *args) == cc_fingerprint(utc, *args)


def test_fingerprint_treats_equal_amounts_alike():
    when = datetime(2026, 11, 20, 14, 3, 0, tzinfo=JAKARTA)
    args = ('BCA', 'XXXX-1111', 'SAMPLE MART', 'Purchase')
    assert cc_fingerprint(when, *args, Decimal('120000.00'), 'IDR') == \
        cc_fingerprint(when, *args, Decimal('120000'), 'IDR')


# --- month and datetime parsing ---------------------------------------------

def test_month_accepts_common_export_formats():
    assert importers.parse_month('2026-11-01') == (date(2026, 11, 1), None)
    assert importers.parse_month('01/11/2026') == (date(2026, 11, 1), None)
    assert importers.parse_month('01-11-2026') == (date(2026, 11, 1), None)


def test_month_not_on_the_first_is_moved_with_a_warning():
    month, warning = importers.parse_month('15/11/2026')
    assert month == date(2026, 11, 1)
    assert warning is not None


def test_month_rejects_garbage():
    with pytest.raises(ValueError):
        importers.parse_month('November')


def test_datetime_accepts_bank_email_style():
    when = importers.parse_datetime('20-11-2026 14:03:00')
    assert when == datetime(2026, 11, 20, 14, 3, tzinfo=JAKARTA)


# --- ledger importer --------------------------------------------------------

def test_ledger_import_reads_every_column():
    csv = LEDGER_CSV_HEADER + '2026-11-01,Groceries (sample),Needs,120.000,Sample Card,FALSE,,TRUE\n' \
          '2026-11-01,Cicilan laptop (sample),Wants,450.000,Sample Card,TRUE,4,FALSE\n'
    report = importers.read_ledger_csv(io.StringIO(csv), Ledger.EXPENSE)
    assert report.errors == []
    first, second = report.rows
    assert (first.amount, first.paid, first.is_installment) == (Decimal('120000'), True, False)
    assert (second.is_installment, second.payments_remaining) == (True, 4)
    assert all(row.ledger == 'expense' for row in report.rows)


def test_ledger_import_reports_bad_rows_with_line_numbers():
    csv = LEDGER_CSV_HEADER + '2026-11-01,Good (sample),Needs,10.000,Cash,FALSE,,FALSE\n' \
          '2026-11-01,Bad amount (sample),Needs,ten,Cash,FALSE,,FALSE\n'
    report = importers.read_ledger_csv(io.StringIO(csv), Ledger.SAVING)
    assert len(report.rows) == 1
    assert report.errors[0][0] == 3  # header is line 1, the bad row is line 3


def test_ledger_import_skips_blank_lines():
    csv = LEDGER_CSV_HEADER + '\n,,,,,,,\n2026-11-01,Item (sample),Needs,1.000,Cash,FALSE,,FALSE\n'
    assert len(importers.read_ledger_csv(io.StringIO(csv), Ledger.SAVING).rows) == 1


def test_missing_column_stops_the_import():
    with pytest.raises(ValueError, match='missing column'):
        importers.read_ledger_csv(io.StringIO('Date,List\n2026-11-01,x\n'), Ledger.SAVING)


def test_empty_file_is_refused():
    with pytest.raises(ValueError, match='no header'):
        importers.read_ledger_csv(io.StringIO(''), Ledger.SAVING)


@pytest.mark.django_db
def test_save_refuses_a_report_with_errors():
    report = importers.read_ledger_csv(io.StringIO(LEDGER_CSV_HEADER + '2026-11-01,x,y,zz,c,FALSE,,FALSE\n'),
                                       Ledger.SAVING)
    with pytest.raises(ValueError, match='bad row'):
        importers.save(report)
    assert LedgerEntry.objects.count() == 0


@pytest.mark.django_db
def test_save_writes_every_row():
    csv = LEDGER_CSV_HEADER + '2026-11-01,A (sample),Needs,1.000,Cash,FALSE,,FALSE\n' \
          '2026-11-01,B (sample),Needs,2.000,Cash,FALSE,,TRUE\n'
    report = importers.save(importers.read_ledger_csv(io.StringIO(csv), Ledger.SAVING))
    assert report.saved == 2
    assert LedgerEntry.objects.filter(ledger='saving').count() == 2


# --- income and cc importers ------------------------------------------------

def test_income_import():
    csv = INCOME_CSV_HEADER + '2026-11-01,Wiva,Salary (sample),10.000.000\n'
    report = importers.read_income_csv(io.StringIO(csv))
    assert report.rows[0].amount == Decimal('10000000')


@pytest.mark.django_db
def test_cc_import_is_idempotent():
    csv = CC_CSV_HEADER + '20-11-2026 14:03:00,BCA,XXXX-1111,SAMPLE MART,Purchase,120.000,IDR\n'
    first = importers.save(importers.read_cc_csv(io.StringIO(csv)))
    second_report = importers.read_cc_csv(io.StringIO(csv))
    importers.drop_known_cc_duplicates(second_report)
    assert first.saved == 1
    assert second_report.rows == []
    assert second_report.skipped_duplicates == 1
    assert CcTransaction.objects.count() == 1


@pytest.mark.django_db
def test_cc_import_drops_duplicates_inside_one_file():
    line = '20-11-2026 14:03:00,BCA,XXXX-1111,SAMPLE MART,Purchase,120.000,IDR\n'
    report = importers.save(importers.read_cc_csv(io.StringIO(CC_CSV_HEADER + line + line)))
    assert report.saved == 1


# --- model rules -------------------------------------------------------------

@pytest.mark.django_db
def test_ledger_month_must_be_the_first_day():
    with pytest.raises(IntegrityError), transaction.atomic():
        LedgerEntry.objects.create(ledger='expense', month=date(2026, 11, 15), list_name='x',
                                   amount=Decimal('1'))


@pytest.mark.django_db
def test_remaining_count_needs_an_installment():
    with pytest.raises(IntegrityError), transaction.atomic():
        LedgerEntry.objects.create(ledger='expense', month=date(2026, 11, 1), list_name='x',
                                   amount=Decimal('1'), is_installment=False, payments_remaining=3)


@pytest.mark.django_db
def test_income_month_must_be_the_first_day():
    with pytest.raises(IntegrityError), transaction.atomic():
        IncomeEntry.objects.create(month=date(2026, 11, 2), person='Wiva', category='x', amount=Decimal('1'))


# --- sample data -------------------------------------------------------------

@pytest.mark.django_db
def test_seed_creates_rows_for_each_month():
    created = fakedata.seed(months=2, end=date(2026, 11, 1), seed_value=7)
    assert created['ledger'] > 0 and created['income'] == 2 * 4
    assert LedgerEntry.objects.values('month').distinct().count() == 2


@pytest.mark.django_db
def test_seed_is_repeatable_and_adds_nothing_the_second_time():
    fakedata.seed(months=2, end=date(2026, 11, 1), seed_value=7)
    ledger_count = LedgerEntry.objects.count()
    cc_count = CcTransaction.objects.count()
    again = fakedata.seed(months=2, end=date(2026, 11, 1), seed_value=7)
    assert again == {'ledger': 0, 'income': 0, 'cc': 0}
    assert LedgerEntry.objects.count() == ledger_count
    assert CcTransaction.objects.count() == cc_count


@pytest.mark.django_db
def test_sample_names_are_marked(settings):
    fakedata.seed(months=1, end=date(2026, 11, 1), seed_value=3)
    assert all('(sample)' in name for name in LedgerEntry.objects.values_list('list_name', flat=True))
    assert all(p.startswith('SAMPLE') for p in CcTransaction.objects.values_list('description', flat=True))


@pytest.mark.django_db
def test_sample_data_is_refused_in_prod(settings):
    settings.APP_ENV = 'prod'
    with pytest.raises(RuntimeError, match='never written in prod'):
        fakedata.seed(months=1, end=date(2026, 11, 1))
    assert LedgerEntry.objects.count() == 0


# --- admin -------------------------------------------------------------------

@pytest.mark.django_db
def test_admin_pages_open_for_a_superuser(client):
    user = get_user_model().objects.create_superuser('admin', 'admin@example.com', 'a-long-test-password-123')
    client.force_login(user)
    for path in ('/api/admin/core/ledgerentry/', '/api/admin/core/incomeentry/', '/api/admin/core/cctransaction/'):
        assert client.get(path).status_code == 200, path


@pytest.mark.django_db
def test_ledger_import_refuses_months_that_already_hold_rows():
    csv = LEDGER_CSV_HEADER + '2026-11-01,A (sample),Needs,1.000,Cash,FALSE,,FALSE\n'
    importers.save(importers.read_ledger_csv(io.StringIO(csv), Ledger.SAVING))
    with pytest.raises(ValueError, match='already exist'):
        importers.save(importers.read_ledger_csv(io.StringIO(csv), Ledger.SAVING))
    assert LedgerEntry.objects.count() == 1


@pytest.mark.django_db
def test_replace_clears_only_the_same_ledger_and_months():
    other = LEDGER_CSV_HEADER + '2026-11-01,Keep (sample),Needs,5.000,Cash,FALSE,,FALSE\n'
    importers.save(importers.read_ledger_csv(io.StringIO(other), Ledger.IBADAH))
    old = LEDGER_CSV_HEADER + '2026-11-01,Old (sample),Needs,1.000,Cash,FALSE,,FALSE\n'
    importers.save(importers.read_ledger_csv(io.StringIO(old), Ledger.SAVING))
    new = LEDGER_CSV_HEADER + '2026-11-01,New (sample),Needs,2.000,Cash,FALSE,,FALSE\n'
    report = importers.save(importers.read_ledger_csv(io.StringIO(new), Ledger.SAVING), replace=True)
    assert report.replaced == 1
    assert sorted(LedgerEntry.objects.values_list('list_name', flat=True)) == ['Keep (sample)', 'New (sample)']


@pytest.mark.django_db
def test_replace_keeps_old_rows_when_the_reload_fails():
    old = LEDGER_CSV_HEADER + '2026-11-01,Old (sample),Needs,1.000,Cash,FALSE,,FALSE\n'
    importers.save(importers.read_ledger_csv(io.StringIO(old), Ledger.SAVING))
    report = importers.read_ledger_csv(io.StringIO(LEDGER_CSV_HEADER + '2026-11-01,New (sample),Needs,2.000,Cash,FALSE,,FALSE\n'), Ledger.SAVING)
    report.rows[0].amount = None  # makes the bulk insert fail after the delete
    with pytest.raises(IntegrityError):
        importers.save(report, replace=True)
    assert LedgerEntry.objects.get().list_name == 'Old (sample)'
