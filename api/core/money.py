"""Rupiah parsing for values read from exported Sheet CSVs.

Google Sheets exports use the locale of the sheet: `120.000` (Indonesian, dot for thousands)
or `120,000` (English). Both are read the same way. A bare number such as `120000.5` keeps its
decimal point. Anything else raises ValueError, so a bad cell is reported instead of guessed.
"""

import re
from decimal import Decimal, InvalidOperation

_ID_THOUSANDS = re.compile(r'^-?\d{1,3}(\.\d{3})+(,\d+)?$')
_EN_THOUSANDS = re.compile(r'^-?\d{1,3}(,\d{3})+(\.\d+)?$')


def parse_idr(text: str) -> Decimal:
    """Return the amount as a Decimal with at most two decimal places."""
    if text is None:
        raise ValueError('amount is empty')
    value = str(text).strip().replace('Rp', '').replace(' ', '')
    if not value:
        raise ValueError('amount is empty')
    if _ID_THOUSANDS.match(value):
        value = value.replace('.', '').replace(',', '.')
    elif _EN_THOUSANDS.match(value):
        value = value.replace(',', '')
    try:
        amount = Decimal(value)
    except InvalidOperation:
        raise ValueError(f'not an amount: {text!r}') from None
    if not amount.is_finite():
        raise ValueError(f'not an amount: {text!r}')
    return amount.quantize(Decimal('0.01'))
