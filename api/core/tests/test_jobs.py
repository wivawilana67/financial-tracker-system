"""The nightly job, the backup, and the Gmail connection. No real Google calls: the network is stubbed."""

import gzip
import json
import time
from datetime import date
from decimal import Decimal
from io import StringIO

import pytest
from django.contrib.auth import get_user_model  # noqa: F401  (keeps the auth app loaded for fixtures)
from django.core import signing
from django.core.cache import cache
from django.core.management import call_command
from rest_framework.test import APIClient

from core import auth, backup, gmail_auth, views_gmail
from core.models import IncomeEntry, LedgerEntry, MonthlyDraft


@pytest.fixture(autouse=True)
def config(settings, monkeypatch, tmp_path):
    settings.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com'
    settings.ALLOWED_EMAILS = frozenset({'owner@example.com'})
    settings.GMAIL_CLIENT_ID = 'gmail-client'
    settings.GMAIL_CLIENT_SECRET = 'gmail-secret'
    settings.GMAIL_REDIRECT_URI = 'https://app.example.test/api/gmail/callback'
    settings.BACKUP_DIR = str(tmp_path / 'backups')
    settings.BACKUP_BUCKET = ''
    cache.clear()
    views_gmail._store = gmail_auth.MemoryStore()
    monkeypatch.setattr(auth.id_token, 'verify_oauth2_token', lambda *a, **k: {
        'iss': 'https://accounts.google.com', 'email': 'owner@example.com', 'email_verified': True,
        'exp': int(time.time()) + 3600})
    yield
    views_gmail._store = None
    cache.clear()


@pytest.fixture
def client():
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION='Bearer ' + 'a' * 150)
    return api


@pytest.mark.django_db
def test_backup_is_a_gzipped_fixture_that_loaddata_can_read(tmp_path):
    IncomeEntry.objects.create(month=date(2026, 11, 1), person='Wiva', category='Salary (sample)',
                               amount=Decimal('10000000'))
    where = backup.run_backup()
    data = json.loads(gzip.decompress(open(where, 'rb').read()))
    assert any(item['model'] == 'core.incomeentry' for item in data)


@pytest.mark.django_db
def test_backup_restores_into_the_same_database(tmp_path):
    LedgerEntry.objects.create(ledger='saving', month=date(2026, 11, 1), list_name='S (sample)', type_name='x',
                               amount=Decimal('1000'))
    where = backup.run_backup()
    LedgerEntry.objects.all().delete()
    call_command('loaddata', where, verbosity=0)
    assert LedgerEntry.objects.filter(list_name='S (sample)').exists()


@pytest.mark.django_db
def test_nightly_writes_a_backup_and_skips_unconnected_inboxes(tmp_path):
    out = StringIO()
    call_command('nightly', '--today', '2026-11-20', stdout=out)
    assert 'backup ok' in out.getvalue()
    assert any(p.name.startswith('fintrack-') and p.name.endswith('.json.gz') for p in (tmp_path / 'backups').iterdir())
    assert MonthlyDraft.objects.count() == 0


@pytest.mark.django_db
def test_nightly_makes_a_draft_only_on_the_first(tmp_path):
    LedgerEntry.objects.create(ledger='saving', month=date(2026, 11, 1), list_name='S (sample)', type_name='x',
                               amount=Decimal('1000'), channel='Cash')
    call_command('nightly', '--today', '2026-12-01', stdout=StringIO())
    draft = MonthlyDraft.objects.get()
    assert draft.month == date(2026, 12, 1)
    assert draft.summary['saving']['inserted'] == 1
    assert not LedgerEntry.objects.filter(month=date(2026, 12, 1)).exists()  # nothing written to the ledgers


@pytest.mark.django_db
def test_nightly_exits_nonzero_when_a_step_fails(monkeypatch, tmp_path):
    def broken(*a, **k):
        raise RuntimeError('disk full')
    monkeypatch.setattr(backup, 'run_backup', broken)
    with pytest.raises(SystemExit) as exit_info:
        call_command('nightly', '--today', '2026-11-20', stdout=StringIO())
    assert exit_info.value.code == 1


@pytest.mark.django_db
def test_connect_returns_a_consent_link_with_a_signed_state(client):
    url = client.get('/api/gmail/connect').json()['url']
    assert 'gmail.readonly' in url and 'access_type=offline' in url and 'state=' in url


@pytest.mark.django_db
def test_callback_with_a_forged_state_is_refused(client):
    res = APIClient().get('/api/gmail/callback?code=abc&state=forged')
    assert res.status_code == 302 and res['Location'].endswith('?gmail=error')


@pytest.mark.django_db
def test_callback_stores_the_token_for_the_owner_who_asked(monkeypatch):
    state = signing.dumps({'email': 'owner@example.com'}, salt=views_gmail.STATE_SALT)
    monkeypatch.setattr(gmail_auth, 'exchange_code', lambda code: 'refresh-abc')
    res = APIClient().get(f'/api/gmail/callback?code=xyz&state={state}')
    assert res['Location'].endswith('?gmail=connected')
    assert views_gmail.store().get('owner@example.com') == 'refresh-abc'


@pytest.mark.django_db
def test_callback_refuses_an_email_off_the_allowlist(monkeypatch):
    state = signing.dumps({'email': 'stranger@example.com'}, salt=views_gmail.STATE_SALT)
    monkeypatch.setattr(gmail_auth, 'exchange_code', lambda code: 'refresh-abc')
    res = APIClient().get(f'/api/gmail/callback?code=xyz&state={state}')
    assert res['Location'].endswith('?gmail=error')
    assert views_gmail.store().get('stranger@example.com') is None


@pytest.mark.django_db
def test_status_shows_only_the_signed_in_owner(client):
    res = client.get('/api/gmail/status').json()
    assert res['inbox'] == 'owner@example.com' and res['connected'] is False


def test_secret_names_do_not_show_the_address():
    name = gmail_auth.secret_name('owner@example.com')
    assert '@' not in name and 'owner' not in name and name.startswith('gmail-refresh-')


@pytest.mark.django_db
def test_drafts_list_and_confirm(client):
    call_command('nightly', '--today', '2026-12-01', stdout=StringIO())
    listed = client.get('/api/drafts').json()['drafts']
    assert len(listed) == 1 and listed[0]['confirmed'] is False
    client.post('/api/drafts/confirm', {'id': listed[0]['id']}, format='json')
    assert client.get('/api/drafts').json()['drafts'][0]['confirmed'] is True
