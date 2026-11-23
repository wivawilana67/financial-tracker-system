"""Duplicate key for card transactions, the same rule as ccFingerprint_() in CcSync.js.

Seven values joined by a NUL byte: datetime (Asia/Jakarta, `yyyy-MM-dd HH:mm:ss`), bank, card,
description, type, amount and currency. Keeping the rule identical means a transaction imported
from the Sheet dedupes against the same transaction synced from Gmail later.
"""

import hashlib
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

JAKARTA = ZoneInfo('Asia/Jakarta')
KEY_SEPARATOR = '\u0000'


def _js_number(amount: Decimal) -> str:
    """Match JavaScript's Number(x) text: 120000 -> '120000', 120000.5 -> '120000.5'."""
    if amount == amount.to_integral_value():
        return str(int(amount))
    return format(amount.normalize(), 'f')


def cc_fingerprint(occurred_at: datetime, bank: str, card: str, description: str,
                   type_name: str, amount: Decimal, currency: str) -> str:
    local = occurred_at.astimezone(JAKARTA).strftime('%Y-%m-%d %H:%M:%S')
    parts = [local, bank.strip(), card.strip(), description.strip(), type_name.strip(),
             _js_number(Decimal(amount)), currency.strip()]
    return hashlib.sha256(KEY_SEPARATOR.join(parts).encode('utf-8')).hexdigest()
