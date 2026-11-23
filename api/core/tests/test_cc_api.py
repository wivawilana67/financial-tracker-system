"""CC Tracker API: filters, version-checked updates, cleanup that hides rather than deletes."""

import time
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from core import auth
from core.fingerprint import cc_fingerprint
from core.models import CcTransaction

JAKARTA = ZoneInfo('Asia/Jakarta')


@pytest.fixture(autouse=True)
def signin(settings, monkeypatch):
    settings.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com'
    settings.ALLOWED_EMAILS = frozenset({'owner@example.com'})
    cache.clear()
    monkeypatch.setattr(auth.id_token, 'verify_oauth2_token', lambda *a, **k: {
        'iss': 'https://accounts.google.com', 'email': 'owner@example.com', 'email_verified': True,
        'exp': int(time.time()) + 3600})
    yield
    cache.clear()


@pytest.fixture
def client():
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION='Bearer ' + 'a' * 150)
    return api


def card(description, **flags):
    when = datetime(2026, 11, 20, 14, 0, tzinfo=JAKARTA)
    fp = cc_fingerprint(when, 'BCA', 'XXXX-1111', description, 'Purchase', Decimal('1000'), 'IDR')
    return CcTransaction.objects.create(occurred_at=when, bank='BCA', card_masked='XXXX-1111',
                                        description=description, type_name='Purchase', amount=Decimal('1000'),
                                        inbox='test', fingerprint=fp, **flags)


@pytest.mark.django_db
def test_all_is_the_working_list_without_hidden_rows(client):
    card('open (sample)')
    card('hidden (sample)', archived=True)
    names = [r['description'] for r in client.get('/api/cc').json()['rows']]
    assert names == ['open (sample)']


@pytest.mark.django_db
def test_hidden_filter_shows_only_hidden(client):
    card('open (sample)')
    card('hidden (sample)', archived=True)
    names = [r['description'] for r in client.get('/api/cc?filter=hidden').json()['rows']]
    assert names == ['hidden (sample)']


@pytest.mark.django_db
def test_unknown_filter_is_refused(client):
    assert client.get('/api/cc?filter=nope').status_code == 400


@pytest.mark.django_db
def test_update_is_version_checked(client):
    row = card('open (sample)')
    res = client.post('/api/cc/update', {'rows': [{'id': row.id, 'version': 9, 'paid': True}]}, format='json').json()
    assert res['updated'] == 0 and res['skipped']
    res = client.post('/api/cc/update', {'rows': [{'id': row.id, 'version': 1, 'paid': True, 'kind': 'cicilan',
                                                   'note': 'lunch'}]}, format='json').json()
    assert res['updated'] == 1
    row.refresh_from_db()
    assert (row.paid, row.kind, row.note, row.version) == (True, 'cicilan', 'lunch', 2)


@pytest.mark.django_db
def test_unknown_kind_is_refused(client):
    row = card('open (sample)')
    res = client.post('/api/cc/update', {'rows': [{'id': row.id, 'version': 1, 'kind': 'maybe'}]}, format='json')
    assert res.status_code == 400


@pytest.mark.django_db
def test_cleanup_hides_and_keeps_every_row(client):
    card('paid (sample)', paid=True)
    card('cancelled (sample)', cancelled=True)
    card('open (sample)')
    assert client.post('/api/cc/cleanup', {}, format='json').json()['hidden'] == 2
    assert CcTransaction.objects.count() == 3


@pytest.mark.django_db
def test_restore_brings_a_hidden_row_back(client):
    row = card('paid (sample)', paid=True, archived=True)
    client.post('/api/cc/restore', {'id': row.id}, format='json')
    row.refresh_from_db()
    assert row.archived is False
