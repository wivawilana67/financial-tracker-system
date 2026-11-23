"""Reads the card notification emails of each connected inbox and stores the transactions.

Duplicates are dropped by fingerprint (the same key as the Sheet's CC Sync), so re-syncing a range
adds nothing. An email that cannot be read is recorded as a ParseFailure (date and reason only).
Gmail's search is padded by a few days on each side, as CC_SEARCH_DAYS_BEFORE/AFTER were; rows outside
the requested range are ignored.
"""

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable

from . import cc_email, gmail, gmail_auth
from .fingerprint import JAKARTA, cc_fingerprint
from .models import CcTransaction, ParseFailure, SyncRun

log = logging.getLogger('fintrack.cc_sync')
DAYS_BEFORE = 5
DAYS_AFTER = 1


@dataclass
class SyncReport:
    runs: list = field(default_factory=list)  # one dict per inbox and bank

    @property
    def saved(self) -> int:
        return sum(r['saved'] for r in self.runs)


def _search_query(base: str, start: date, end: date) -> str:
    after = start - timedelta(days=DAYS_BEFORE)
    before = end + timedelta(days=DAYS_AFTER + 1)
    return f'({base}) after:{after:%Y/%m/%d} before:{before:%Y/%m/%d}'


def sync_range(start: date, end: date, inboxes: list, store, client_factory: Callable | None = None,
               token_refresh: Callable | None = None) -> SyncReport:
    """Syncs start..end (inclusive, Jakarta dates) for each inbox.

    `client_factory(access_token)` and `token_refresh(refresh_token)` default to the real Gmail calls;
    tests pass fakes.
    """
    if end < start:
        raise ValueError('end is before start')
    make_client = client_factory or (lambda token: gmail.GmailClient(token))
    refresh = token_refresh or gmail_auth.access_token
    report = SyncReport()

    for inbox in inboxes:
        for source in cc_email.SOURCES:
            run = SyncRun.objects.create(inbox=inbox, bank=source.bank, range_start=start, range_end=end)
            refresh_token = store.get(inbox)
            if not refresh_token:
                run.status, run.note = 'skipped', 'inbox not connected'
                run.save()
                report.runs.append({'inbox': inbox, 'bank': source.bank, 'saved': 0, 'status': 'skipped'})
                continue
            try:
                client = make_client(refresh(refresh_token))
                ids = client.search(_search_query(source.query, start, end))
                messages = sorted((client.fetch(i) for i in ids), key=lambda m: m.received)
                state = cc_email.ParseState()
                saved = 0
                for message in messages:
                    try:
                        tx = source.parse(cc_email.clean_body(message.text), message.received, state)
                    except ValueError as err:
                        ParseFailure.objects.create(inbox=inbox, bank=source.bank,
                                                    received=message.received, reason=str(err)[:200])
                        run.failed += 1
                        continue
                    local_day = tx.timestamp.astimezone(JAKARTA).date()
                    if not start <= local_day <= end:
                        continue
                    fingerprint = cc_fingerprint(tx.timestamp, source.bank, tx.card, tx.merchant,
                                                 tx.type_name, tx.amount, tx.currency)
                    _, created = CcTransaction.objects.get_or_create(
                        fingerprint=fingerprint,
                        defaults=dict(occurred_at=tx.timestamp, bank=source.bank, card_masked=tx.card,
                                      description=tx.merchant, type_name=tx.type_name, amount=tx.amount,
                                      currency=tx.currency, inbox=inbox))
                    saved += int(created)
                run.found, run.saved = len(messages), saved
                run.save()
                report.runs.append({'inbox': inbox, 'bank': source.bank, 'saved': saved, 'status': 'ok'})
            except (gmail.GmailError, gmail_auth.AuthError) as err:
                run.status, run.note = 'error', str(err)[:200]
                run.save()
                report.runs.append({'inbox': inbox, 'bank': source.bank, 'saved': 0, 'status': 'error'})
                log.warning('sync failed inbox-run=%s reason=%s', run.id, err)
    return report
