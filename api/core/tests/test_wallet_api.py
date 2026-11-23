import time
from decimal import Decimal

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from core import auth
from core.models import WalletEntry


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


def new_entry(**kw):
    base = dict(list_usage='Sample gadget (sample)', price=Decimal('450000'), account='Bank A',
                is_income=False, paid=True, is_installment=True, months_total=6, ticks=[True] * 3)
    base.update(kw)
    return WalletEntry.objects.create(**base)


@pytest.mark.django_db
def test_list_shows_instalment_and_account_balance(client):
    new_entry()  # 450000 over 6 months, 3 ticks paid, expense and paid
    new_entry(price=Decimal('1000000'), is_income=True, is_installment=False, months_total=None, ticks=[])
    body = client.get('/api/wallet').json()
    installment = next(r for r in body['rows'] if r['cicil'])
    assert installment['instalment'] == '75000.00' and installment['instalments_paid'] == '225000.00'
    # 1,000,000 income - 450,000 expense + 450,000 cicil - 225,000 instalments paid = 775,000
    assert body['accounts'] == [{'name': 'Bank A', 'balance': '775000.00'}]


@pytest.mark.django_db
def test_update_is_version_checked(client):
    entry = new_entry()
    res = client.post('/api/wallet/update', {'id': entry.id, 'version': 9, 'list': 'x', 'price': '1',
                                             'account': 'Bank A'}, format='json')
    assert res.status_code == 409
    res = client.post('/api/wallet/update', {'id': entry.id, 'version': 1, 'list': 'x', 'price': '1',
                                             'account': 'Bank A', 'cicil': False}, format='json')
    assert res.json()['updated'] is True
    entry.refresh_from_db()
    assert entry.version == 2 and entry.list_usage == 'x'


@pytest.mark.django_db
def test_a_cicilan_needs_its_months(client):
    res = client.post('/api/wallet/add', {'list': 'x', 'price': '100', 'account': 'A', 'cicil': True},
                      format='json')
    assert res.status_code == 400


@pytest.mark.django_db
def test_delete_is_version_checked(client):
    entry = new_entry()
    assert client.post('/api/wallet/delete', {'id': entry.id, 'version': 5}, format='json').status_code == 409
    assert client.post('/api/wallet/delete', {'id': entry.id, 'version': 1}, format='json').json()['deleted']
