"""Health, session and Google sign-in checks. Google's verifier is replaced with a fake."""

import time
from datetime import datetime, timezone

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from core import auth
from core.views import current_month_key

ALLOWED = 'owner@example.com'
TOKEN = 'a' * 150


@pytest.fixture(autouse=True)
def signin_settings(settings):
    settings.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com'
    settings.ALLOWED_EMAILS = frozenset({ALLOWED, 'partner@example.com'})
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def client():
    return APIClient()


def claims(**overrides):
    base = {
        'iss': 'https://accounts.google.com',
        'aud': 'client-123.apps.googleusercontent.com',
        'email': 'Owner@Example.com',
        'email_verified': True,
        'exp': int(time.time()) + 3600,
    }
    base.update(overrides)
    return base


@pytest.fixture
def google(monkeypatch):
    """Fake Google verifier. Set .result to claims or to an exception; .calls counts checks."""

    class Fake:
        result = claims()
        calls = 0
        audience = None

    def verify(token, request, audience=None, clock_skew_in_seconds=0):
        Fake.calls += 1
        Fake.audience = audience
        if isinstance(Fake.result, Exception):
            raise Fake.result
        return Fake.result

    monkeypatch.setattr(auth.id_token, 'verify_oauth2_token', verify)
    return Fake


def bearer(token=TOKEN):
    return {'HTTP_AUTHORIZATION': f'Bearer {token}'}


def test_health_is_public_and_skips_the_database(client):
    # No django_db mark: any database access here would raise.
    res = client.get('/api/health')
    assert res.status_code == 200
    assert res.json()['status'] == 'ok'
    assert res.json()['env'] == 'local'


def test_session_without_token_is_401_with_bare_message(client):
    res = client.get('/api/session')
    assert res.status_code == 401
    assert res.json() == {'error': 'Unauthorized'}
    assert res.headers['WWW-Authenticate'] == 'Bearer'


def test_session_with_valid_token(client, google):
    res = client.get('/api/session', **bearer())
    assert res.status_code == 200
    body = res.json()
    assert body['email'] == ALLOWED  # lowercased
    assert body['env'] == 'local'
    assert len(body['month']) == 7
    assert google.audience == 'client-123.apps.googleusercontent.com'


def test_verified_token_is_cached(client, google):
    client.get('/api/session', **bearer())
    client.get('/api/session', **bearer())
    assert google.calls == 1


@pytest.mark.parametrize('bad', [
    claims(email='stranger@example.com'),
    claims(email_verified=False),
    claims(email_verified='true'),  # must be a real boolean
    claims(iss='https://evil.example.com'),
    claims(email=''),
    ValueError('Token expired'),
    ValueError('Wrong audience'),
])
def test_rejected_tokens_are_401(client, google, bad):
    google.result = bad
    res = client.get('/api/session', **bearer())
    assert res.status_code == 401
    assert res.json() == {'error': 'Unauthorized'}


@pytest.mark.parametrize('header', ['Basic abc', 'Bearer', 'Token ' + TOKEN])
def test_wrong_header_shape_is_401(client, google, header):
    res = client.get('/api/session', HTTP_AUTHORIZATION=header)
    assert res.status_code == 401
    assert google.calls == 0


def test_short_or_huge_tokens_never_reach_google(client, google):
    assert client.get('/api/session', **bearer('x' * 20)).status_code == 401
    assert client.get('/api/session', **bearer('x' * 5000)).status_code == 401
    assert google.calls == 0


def test_rejected_token_is_not_cached(client, google):
    google.result = claims(email='stranger@example.com')
    client.get('/api/session', **bearer())
    google.result = claims()
    assert client.get('/api/session', **bearer()).status_code == 200


def test_throttle_locks_new_tokens_but_keeps_cached_ones(client, google):
    client.get('/api/session', **bearer())  # cache a good token first
    google.result = ValueError('bad')
    for i in range(auth.FAIL_LIMIT):
        client.get('/api/session', **bearer('b' * 150 + str(i)))
    google.result = claims()
    calls_before = google.calls
    assert client.get('/api/session', **bearer('c' * 150)).status_code == 401
    assert google.calls == calls_before  # refused before asking Google
    assert client.get('/api/session', **bearer()).status_code == 200


def test_missing_configuration_refuses_everyone(client, google, settings):
    settings.ALLOWED_EMAILS = frozenset()
    assert client.get('/api/session', **bearer()).status_code == 401
    assert google.calls == 0


@pytest.mark.django_db
def test_health_db_needs_sign_in_then_reaches_the_database(client, google):
    assert client.get('/api/health/db').status_code == 401
    res = client.get('/api/health/db', **bearer())
    assert res.status_code == 200
    assert res.json()['status'] == 'ok'


def test_current_month_uses_jakarta_time():
    # 2026-11-30 18:00 UTC is already 1 December in Jakarta (UTC+7).
    assert current_month_key(datetime(2026, 11, 30, 18, 0, tzinfo=timezone.utc)) == '2026-12'
    assert current_month_key(datetime(2026, 11, 30, 16, 0, tzinfo=timezone.utc)) == '2026-11'
