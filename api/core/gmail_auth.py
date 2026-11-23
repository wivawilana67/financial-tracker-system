"""Connecting a Gmail inbox: the consent link, the code exchange, and refresh tokens in Secret Manager.

Refresh tokens never go in the database, the repo or a log. Each inbox has its own secret, named by a
hash of the address so the secret name does not show the address.
"""

import base64
import hashlib
import logging
from urllib.parse import urlencode

import requests
from django.conf import settings

log = logging.getLogger('fintrack.gmail.auth')

AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
SM_API = 'https://secretmanager.googleapis.com/v1'
METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
TIMEOUT = 20


class AuthError(RuntimeError):
    pass


def secret_name(inbox: str) -> str:
    return 'gmail-refresh-' + hashlib.sha256(inbox.strip().lower().encode()).hexdigest()[:20]


def consent_url(state: str) -> str:
    params = {
        'client_id': settings.GMAIL_CLIENT_ID,
        'redirect_uri': settings.GMAIL_REDIRECT_URI,
        'response_type': 'code',
        'scope': SCOPE,
        'access_type': 'offline',   # so Google issues a refresh token
        'prompt': 'consent',        # so it is issued every time, not only the first
        'state': state,
    }
    return f'{AUTH_URL}?{urlencode(params)}'


def exchange_code(code: str) -> str:
    """Trades the one-time code from the callback for a refresh token."""
    res = requests.post(TOKEN_URL, data={
        'code': code, 'client_id': settings.GMAIL_CLIENT_ID, 'client_secret': settings.GMAIL_CLIENT_SECRET,
        'redirect_uri': settings.GMAIL_REDIRECT_URI, 'grant_type': 'authorization_code',
    }, timeout=TIMEOUT)
    body = res.json() if res.content else {}
    if res.status_code != 200 or 'refresh_token' not in body:
        log.warning('gmail code exchange failed status=%s', res.status_code)
        raise AuthError('Google did not return a refresh token')
    return body['refresh_token']


def access_token(refresh_token: str) -> str:
    """A short-lived access token for one sync run."""
    res = requests.post(TOKEN_URL, data={
        'refresh_token': refresh_token, 'client_id': settings.GMAIL_CLIENT_ID,
        'client_secret': settings.GMAIL_CLIENT_SECRET, 'grant_type': 'refresh_token',
    }, timeout=TIMEOUT)
    body = res.json() if res.content else {}
    if res.status_code != 200 or 'access_token' not in body:
        log.warning('gmail refresh failed status=%s (the inbox may need to be connected again)', res.status_code)
        raise AuthError('the Gmail connection needs to be made again')
    return body['access_token']


def _cloud_token() -> str:
    """This service's own identity token from the Cloud Run metadata server."""
    res = requests.get(METADATA_TOKEN, headers={'Metadata-Flavor': 'Google'}, timeout=TIMEOUT)
    res.raise_for_status()
    return res.json()['access_token']


class SecretManagerStore:
    """Refresh tokens as Secret Manager secrets, read and written with this service's identity."""

    def __init__(self, project: str | None = None):
        self.project = project or settings.GCP_PROJECT_ID

    def _headers(self) -> dict:
        return {'Authorization': f'Bearer {_cloud_token()}'}

    def get(self, inbox: str) -> str | None:
        name = secret_name(inbox)
        url = f'{SM_API}/projects/{self.project}/secrets/{name}/versions/latest:access'
        res = requests.get(url, headers=self._headers(), timeout=TIMEOUT)
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return base64.b64decode(res.json()['payload']['data']).decode()

    def put(self, inbox: str, token: str) -> None:
        name = secret_name(inbox)
        base = f'{SM_API}/projects/{self.project}/secrets'
        create = requests.post(f'{base}?secretId={name}', headers=self._headers(),
                               json={'replication': {'automatic': {}}}, timeout=TIMEOUT)
        if create.status_code not in (200, 409):  # 409: the secret already exists
            create.raise_for_status()
        data = base64.b64encode(token.encode()).decode()
        requests.post(f'{base}/{name}:addVersion', headers=self._headers(),
                      json={'payload': {'data': data}}, timeout=TIMEOUT).raise_for_status()


class MemoryStore:
    """For tests and local runs. Nothing is kept after the process ends."""

    def __init__(self):
        self._tokens: dict[str, str] = {}

    def get(self, inbox: str) -> str | None:
        return self._tokens.get(inbox.strip().lower())

    def put(self, inbox: str, token: str) -> None:
        self._tokens[inbox.strip().lower()] = token


def default_store():
    return MemoryStore() if settings.APP_ENV == 'local' else SecretManagerStore()
