"""The Gmail read path, over the REST API (no client library).

Only what the card sync needs: search message ids, and read one message's text and received time.
Reading is read-only: the scope is gmail.readonly.
"""

import base64
from dataclasses import dataclass
from datetime import datetime, timezone

import requests

API = 'https://gmail.googleapis.com/gmail/v1/users/me'
PAGE = 100
TIMEOUT = 20


class GmailError(RuntimeError):
    pass


@dataclass(frozen=True)
class Message:
    text: str
    received: datetime


def _decode(data: str) -> str:
    padded = data + '=' * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode()).decode('utf-8', errors='replace')


def _find_body(part: dict, mime: str):
    if part.get('mimeType') == mime and part.get('body', {}).get('data'):
        return _decode(part['body']['data'])
    for child in part.get('parts', []) or []:
        found = _find_body(child, mime)
        if found is not None:
            return found
    return None


def message_text(payload: dict) -> str:
    """The HTML part when there is one, otherwise the plain text."""
    html = _find_body(payload, 'text/html')
    if html is not None:
        return html
    plain = _find_body(payload, 'text/plain')
    return plain or ''


class GmailClient:
    def __init__(self, access_token: str, session=None):
        self._headers = {'Authorization': f'Bearer {access_token}'}
        self._session = session or requests

    def _get(self, path: str, params: dict | None = None) -> dict:
        res = self._session.get(f'{API}/{path}', headers=self._headers, params=params or {}, timeout=TIMEOUT)
        if res.status_code != 200:
            raise GmailError(f'Gmail answered {res.status_code}')
        return res.json()

    def search(self, query: str) -> list[str]:
        ids, token = [], None
        while True:
            params = {'q': query, 'maxResults': PAGE}
            if token:
                params['pageToken'] = token
            body = self._get('messages', params)
            ids += [m['id'] for m in body.get('messages', [])]
            token = body.get('nextPageToken')
            if not token:
                return ids

    def fetch(self, message_id: str) -> Message:
        body = self._get(f'messages/{message_id}', {'format': 'full'})
        received = datetime.fromtimestamp(int(body['internalDate']) / 1000, tz=timezone.utc)
        return Message(text=message_text(body.get('payload', {})), received=received)
