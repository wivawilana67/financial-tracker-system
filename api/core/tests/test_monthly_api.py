"""The monthly phone API: sign-in is required, money travels as strings, and writes are checked."""

import time
from datetime import date
from decimal import Decimal

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from core import auth
from core.models import IncomeEntry, LedgerEntry

NOV = '2026-11'
TOKEN = 'a' * 150


@pytest.fixture(autouse=True)
def signin(settings, monkeypatch):
    settings.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com'
    settings.ALLOWED_EMAILS = frozenset({'owner@example.com'})
    cache.clear()

    def verify(token, request, audience=None, clock_skew_in_seconds=0):
        return {'iss': 'https://accounts.google.com', 'email': 'owner@example.com', 'email_verified': True,
                'exp': int(time.time()) + 3600}

    monkeypatch.setattr(auth.id_token, 'verify_oauth2_token', verify)
    yield
    cache.clear()


@pytest.fixture
def client():
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f'Bearer {TOKEN}')
    return api


def test_every_monthly_route_needs_sign_in():
    anonymous = APIClient()
    assert anonymous.get(f'/api/dashboard?month={NOV}').status_code == 401
    assert anonymous.post('/api/rollover/preview', {}, format='json').status_code == 401


def test_bad_month_is_a_400_with_a_clear_message(client):
    res = client.get('/api/dashboard?month=2026-13')
    assert res.status_code == 400 and 'month' in res.json()['fields']


@pytest.mark.django_db
def test_dashboard_returns_money_as_strings(client):
    IncomeEntry.objects.create(month=date(2026, 11, 1), person='Wiva', category='Salary (sample)',
                               amount=Decimal('10000000'))
    LedgerEntry.objects.create(ledger='saving', month=date(2026, 11, 1), list_name='S', type_name='x',
                               amount=Decimal('4000000'))
    body = client.get(f'/api/dashboard?month={NOV}').json()
    assert body['income'] == '10000000.00'
    saving = next(l for l in body['ledgers'] if l['ledger'] == 'saving')
    assert saving['total'] == '4000000.00' and saving['target'] == '4000000.00'


@pytest.mark.django_db
def test_ledger_rows_list_with_versions(client):
    LedgerEntry.objects.create(ledger='expense', month=date(2026, 11, 1), list_name='G (sample)', type_name='Needs',
                               amount=Decimal('1000'), channel='Cash')
    body = client.get(f'/api/ledger?month={NOV}&ledger=expense').json()
    assert body['rows'][0]['version'] == 1 and body['rows'][0]['amount'] == '1000.00'


@pytest.mark.django_db
def test_an_unknown_ledger_is_refused(client):
    assert client.get(f'/api/ledger?month={NOV}&ledger=nope').status_code == 400


@pytest.mark.django_db
def test_changes_endpoint_skips_a_stale_version(client):
    row = LedgerEntry.objects.create(ledger='saving', month=date(2026, 11, 1), list_name='S', type_name='x',
                                     amount=Decimal('1000'))
    body = {'month': NOV, 'updates': [{'id': row.id, 'version': 99, 'amount': '5000'}]}
    res = client.post('/api/monthly/changes', body, format='json').json()
    assert res['updated'] == 0 and res['skipped']


@pytest.mark.django_db
def test_changes_endpoint_refuses_a_negative_amount(client):
    body = {'month': NOV, 'additions': [{'ledger': 'saving', 'amount': '-5'}]}
    assert client.post('/api/monthly/changes', body, format='json').status_code == 400


@pytest.mark.django_db
def test_rollover_preview_writes_nothing_and_apply_writes(client):
    LedgerEntry.objects.create(ledger='saving', month=date(2026, 10, 1), list_name='S (sample)', type_name='x',
                               amount=Decimal('1000'), channel='Cash')
    body = {'month': NOV, 'selected': ['saving|S (sample)|x|Cash'], 'income': [], 'jajan_base': {}}
    before = LedgerEntry.objects.count()
    preview = client.post('/api/rollover/preview', body, format='json').json()
    assert preview['summary']['saving']['inserted'] == 1
    assert preview['summary']['expense']['inserted'] == 2
    assert LedgerEntry.objects.count() == before
    applied = client.post('/api/rollover/apply', body, format='json').json()
    # One saving row, plus the two Jajan rows every generation writes.
    assert applied['written']['inserted'] == 3
    assert LedgerEntry.objects.count() == before + 3


@pytest.mark.django_db
def test_mark_paid_endpoint(client):
    LedgerEntry.objects.create(ledger='saving', month=date(2026, 11, 1), list_name='S', type_name='x',
                               amount=Decimal('1000'), channel='Sample Card')
    res = client.post('/api/monthly/paid', {'month': NOV, 'channels': ['sample card'], 'rows': []}, format='json')
    assert res.json()['marked'] == 1


@pytest.mark.django_db
def test_simulation_takes_what_if_amounts(client):
    res = client.get(f'/api/simulation?month={NOV}&income=12000000').json()
    assert res['income'] == '12000000.00'
    assert res['remaining'] == '12000000.00'


@pytest.mark.django_db
def test_candidates_list_the_source_month_with_their_uids(client):
    LedgerEntry.objects.create(ledger='saving', month=date(2026, 10, 1), list_name='S (sample)', type_name='x',
                               amount=Decimal('1000'), channel='Cash')
    body = client.get(f'/api/rollover/candidates?month={NOV}').json()
    assert body['source'] == '2026-10-01'
    (item,) = body['candidates']
    assert item['uid'] == 'saving|S (sample)|x|Cash' and item['amount'] == '1000.00'
