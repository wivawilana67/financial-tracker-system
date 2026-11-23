"""The card sync, with a fake Gmail. Sample emails are invented."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from core import gmail
from core.cc_sync import sync_range
from core.gmail import Message
from core.gmail_auth import MemoryStore
from core.models import CcTransaction, ParseFailure, SyncRun

UTC = ZoneInfo('UTC')


def email(day, amount='120.000', card='XXXXXXXXXXXX1111', merchant='SAMPLE MART'):
    return (f'Nomor Kartu : {card} Pada Tanggal : {day:%d-%m-%Y} 14:03:00 '
            f'Merchant / ATM : {merchant} Jenis Transaksi : Purchase Sejumlah : IDR {amount}')


class FakeClient:
    def __init__(self, messages):
        self.messages = messages  # id -> Message

    def search(self, query):
        self.query = query
        return list(self.messages)

    def fetch(self, message_id):
        return self.messages[message_id]


def factory(messages):
    client = FakeClient(messages)
    return (lambda token: client), client


def store_with(inbox):
    store = MemoryStore()
    store.put(inbox, 'refresh-token')
    return store


@pytest.mark.django_db
def test_sync_saves_each_transaction_once():
    day = date(2026, 11, 20)
    messages = {'a': Message(email(day), datetime(2026, 11, 20, 7, tzinfo=UTC))}
    make, _ = factory(messages)
    store = store_with('owner@example.com')
    first = sync_range(day, day, ['owner@example.com'], store, make, lambda t: 'access')
    second = sync_range(day, day, ['owner@example.com'], store, make, lambda t: 'access')
    assert first.saved == 1 and second.saved == 0
    assert CcTransaction.objects.count() == 1


@pytest.mark.django_db
def test_rows_outside_the_range_are_ignored():
    messages = {'a': Message(email(date(2026, 11, 25)), datetime(2026, 11, 25, 7, tzinfo=UTC))}
    make, _ = factory(messages)
    report = sync_range(date(2026, 11, 20), date(2026, 11, 20), ['owner@example.com'],
                        store_with('owner@example.com'), make, lambda t: 'access')
    assert report.saved == 0 and CcTransaction.objects.count() == 0


@pytest.mark.django_db
def test_the_search_is_padded_around_the_range():
    make, client = factory({})
    sync_range(date(2026, 11, 20), date(2026, 11, 20), ['owner@example.com'],
               store_with('owner@example.com'), make, lambda t: 'access')
    assert 'after:2026/11/15' in client.query and 'before:2026/11/22' in client.query


@pytest.mark.django_db
def test_an_unreadable_email_is_recorded_without_its_text():
    messages = {'a': Message('Nothing about money here', datetime(2026, 11, 20, 7, tzinfo=UTC))}
    make, _ = factory(messages)
    sync_range(date(2026, 11, 20), date(2026, 11, 20), ['owner@example.com'],
               store_with('owner@example.com'), make, lambda t: 'access')
    failure = ParseFailure.objects.get()
    assert failure.reason == 'amount not found'
    assert 'Nothing about money' not in failure.reason


@pytest.mark.django_db
def test_an_inbox_without_a_connection_is_skipped_and_recorded():
    make, _ = factory({})
    report = sync_range(date(2026, 11, 20), date(2026, 11, 20), ['nobody@example.com'], MemoryStore(), make,
                        lambda t: 'access')
    assert report.runs[0]['status'] == 'skipped'
    assert SyncRun.objects.get().note == 'inbox not connected'


@pytest.mark.django_db
def test_a_gmail_error_is_recorded_and_does_not_stop_the_other_inboxes():
    def broken(token):
        raise gmail.GmailError('Gmail answered 503')
    store = store_with('a@example.com')
    store.put('b@example.com', 'refresh-token')
    make, _ = factory({})
    report = sync_range(date(2026, 11, 20), date(2026, 11, 20), ['a@example.com', 'b@example.com'], store,
                        lambda t: make(t), lambda t: 'access')
    assert len(report.runs) == 2
    report = sync_range(date(2026, 11, 20), date(2026, 11, 20), ['a@example.com'], store, broken, lambda t: 'access')
    assert report.runs[0]['status'] == 'error'


def test_end_before_start_is_refused():
    with pytest.raises(ValueError):
        sync_range(date(2026, 11, 20), date(2026, 11, 19), [], MemoryStore())
