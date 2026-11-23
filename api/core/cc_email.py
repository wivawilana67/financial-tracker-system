"""Card notification emails: the BCA parser, ported from CcSync.js (cleanEmailBody_, parseBcaCcEmail_).

Each bank is one entry in SOURCES: the Gmail search that finds its emails, and the parser that reads
one email. Adding a bank means adding an entry; sync, storage and the screens stay the same.
"""

import html as html_lib
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Callable
from zoneinfo import ZoneInfo

JAKARTA = ZoneInfo('Asia/Jakarta')
_STYLE = re.compile(r'<style[^>]*>.*?</style>', re.I | re.S)
_SCRIPT = re.compile(r'<script[^>]*>.*?</script>', re.I | re.S)
_TAG = re.compile(r'<[^>]+>')
_SPACE = re.compile(r'\s+')


def clean_body(raw: str) -> str:
    """Plain text with the tags, styles and scripts removed and whitespace collapsed (cleanEmailBody_)."""
    text = _STYLE.sub(' ', raw)
    text = _SCRIPT.sub(' ', text)
    text = _TAG.sub(' ', text)
    text = re.sub(r'&nbsp;', ' ', text, flags=re.I)
    text = html_lib.unescape(text) if '&' in text else text
    return _SPACE.sub(' ', text)


@dataclass
class ParseState:
    """Carried between the emails of one sync, for notifications that leave a field out."""
    last_card: str = 'Unknown'
    last_merchant: str = 'Unknown'


@dataclass(frozen=True)
class CardTransaction:
    timestamp: datetime
    card: str
    merchant: str
    type_name: str
    amount: Decimal
    currency: str


def _js_amount(text: str) -> Decimal:
    """parseFloat(text.replace(/\\./g,'').replace(/,/g,'.')): dots are thousands, a comma is the decimal point."""
    cleaned = text.strip().replace('.', '').replace(',', '.')
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        raise ValueError(f'unreadable amount {text!r}') from None


def parse_bca(body: str, received: datetime, state: ParseState):
    """One BCA "Credit Card Transaction Notification". Returns CardTransaction, or raises ValueError."""
    amount_match = (re.search(r'Sejumlah\s*:\s*(Rp|IDR|[A-Z]{3})\s*([\d.,]+)', body, re.I)
                    or re.search(r'Sejumlah\s*:\s*([A-Za-z]+)?\s*([\d.,]+)', body, re.I))
    if not amount_match:
        raise ValueError('amount not found')  # never echo the email text into logs or the database

    timestamp = received.astimezone(JAKARTA)
    exact = re.search(r'Pada Tanggal\s*:\s*(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2}:\d{2})', body, re.I)
    if exact:
        timestamp = datetime.strptime(f'{exact.group(1)} {exact.group(2)}', '%d-%m-%Y %H:%M:%S').replace(tzinfo=JAKARTA)

    card_match = re.search(r'Nomor Kartu\s*:\s*([0-9X]+)', body, re.I)
    merchant_match = re.search(r'Merchant / ATM\s*:\s*(.*?)(?=Jenis Transaksi)', body, re.I)
    card = card_match.group(1).strip() if card_match else state.last_card
    merchant = merchant_match.group(1).strip() if merchant_match else state.last_merchant
    if card != 'Unknown':
        state.last_card = card
    if merchant != 'Unknown':
        state.last_merchant = merchant

    type_name = 'Void' if re.search(r'Void|Reversal|Batal', body, re.I) else 'Transaction'
    raw_currency = amount_match.group(1).strip().upper() if amount_match.group(1) else 'IDR'
    amount = _js_amount(amount_match.group(2))
    if type_name == 'Void':
        amount = -abs(amount)
    return CardTransaction(timestamp=timestamp, card=card, merchant=merchant, type_name=type_name,
                           amount=amount, currency='IDR' if raw_currency == 'RP' else raw_currency)


@dataclass(frozen=True)
class Source:
    bank: str
    query: str                                  # Gmail search, without the date range
    parse: Callable[[str, datetime, ParseState], CardTransaction]


SOURCES = (
    Source(
        bank='BCA',
        query='(label:"Notif CC BCA" OR subject:"Credit Card Transaction Notification")',
        parse=parse_bca,
    ),
)
