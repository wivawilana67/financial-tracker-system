"""The BCA notification parser, on invented sample emails. No real card or merchant appears here."""

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from core.cc_email import JAKARTA, ParseState, clean_body, parse_bca

RECEIVED = datetime(2026, 11, 20, 8, 0, tzinfo=ZoneInfo('UTC'))

SAMPLE = (
    '<html><style>.x{}</style><body>'
    'Nomor Kartu : XXXXXXXXXXXX1111 '
    'Pada Tanggal : 20-11-2026 14:03:00 '
    'Merchant / ATM : SAMPLE MART Jenis Transaksi : Purchase '
    'Sejumlah : IDR 120.000,00'
    '</body></html>'
)


def test_clean_body_drops_tags_and_styles():
    text = clean_body(SAMPLE)
    assert '<' not in text and '.x{}' not in text
    assert 'Sejumlah : IDR 120.000,00' in text


def test_exact_date_wins_over_the_received_time():
    tx = parse_bca(clean_body(SAMPLE), RECEIVED, ParseState())
    assert tx.timestamp == datetime(2026, 11, 20, 14, 3, tzinfo=JAKARTA)
    assert tx.amount == Decimal('120000.00') and tx.currency == 'IDR'
    assert tx.card == 'XXXXXXXXXXXX1111' and tx.merchant == 'SAMPLE MART'
    assert tx.type_name == 'Transaction'


def test_a_void_is_negative():
    body = clean_body(SAMPLE.replace('Purchase', 'Void'))
    tx = parse_bca(body.replace('Jenis Transaksi : Void', 'Jenis Transaksi : Void Reversal'), RECEIVED, ParseState())
    assert tx.type_name == 'Void' and tx.amount < 0


def test_missing_fields_carry_from_the_previous_email():
    state = ParseState()
    parse_bca(clean_body(SAMPLE), RECEIVED, state)
    later = clean_body('Sejumlah : IDR 5.000,00')
    tx = parse_bca(later, RECEIVED, state)
    assert tx.card == 'XXXXXXXXXXXX1111' and tx.merchant == 'SAMPLE MART'
    assert tx.timestamp == RECEIVED.astimezone(JAKARTA)


def test_an_email_without_an_amount_is_refused():
    with pytest.raises(ValueError):
        parse_bca(clean_body('Something else entirely'), RECEIVED, ParseState())


def test_a_bare_rp_currency_becomes_idr():
    tx = parse_bca(clean_body('Sejumlah : Rp 1.500'), RECEIVED, ParseState())
    assert tx.currency == 'IDR' and tx.amount == Decimal('1500')
