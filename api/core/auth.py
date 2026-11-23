"""Google Sign-In for the API.

Every request (except /api/health) must carry `Authorization: Bearer <Google ID token>`.
The token must be signed by Google for this app's client ID, unexpired, for a verified email,
and that email must be on ALLOWED_EMAILS. This replaces Auth.js, including its shared token.

Kept from Auth.js:
- Callers only ever see "Unauthorized"; the reason goes to the log, the token never does.
- Verified tokens are cached until shortly before they expire (keyed by a SHA-256 of the token).
- Too many failures inside a window lock the API for that window.
"""

import hashlib
import logging
import time
from dataclasses import dataclass

import requests
from django.conf import settings
from django.core.cache import cache
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from rest_framework import authentication, exceptions

log = logging.getLogger('fintrack.auth')

GOOGLE_ISSUERS = frozenset({'accounts.google.com', 'https://accounts.google.com'})
MIN_TOKEN_LENGTH = 100
MAX_TOKEN_LENGTH = 4096
CACHE_SAFETY_SECONDS = 30
FAIL_LIMIT = 20             # failed calls ...
FAIL_WINDOW_SECONDS = 600   # ... within this window lock the API for the same window
FAIL_KEY = 'auth:fails'
CLOCK_SKEW_SECONDS = 10

# One HTTP session for Google's certificate downloads, reused across requests.
_google_request = GoogleRequest(session=requests.Session())


@dataclass(frozen=True)
class SignedInUser:
    """The caller, as proven by the Google ID token. Not a database user."""

    email: str
    is_authenticated: bool = True
    is_anonymous: bool = False

    def __str__(self):
        return self.email


class Unauthorized(exceptions.AuthenticationFailed):
    default_detail = 'Unauthorized'


def _token_key(token: str) -> str:
    return 'idt:' + hashlib.sha256(token.encode()).hexdigest()


def _is_throttled() -> bool:
    return (cache.get(FAIL_KEY) or 0) >= FAIL_LIMIT


def _record_failure(reason: str) -> None:
    # add() starts the window only once; incr() keeps its expiry.
    cache.add(FAIL_KEY, 0, FAIL_WINDOW_SECONDS)
    try:
        count = cache.incr(FAIL_KEY)
    except ValueError:  # expired between add() and incr()
        cache.set(FAIL_KEY, 1, FAIL_WINDOW_SECONDS)
        count = 1
    log.warning('auth failed reason=%s failures_in_window=%s', reason, count)


def verify_google_user(token: str) -> str:
    """Return the lowercased, allowlisted email for a valid ID token, or raise Unauthorized."""
    if not isinstance(token, str) or not MIN_TOKEN_LENGTH <= len(token) <= MAX_TOKEN_LENGTH:
        _record_failure('malformed')
        raise Unauthorized()

    key = _token_key(token)
    cached = cache.get(key)
    if cached:
        return cached

    if _is_throttled():
        log.warning('auth refused: throttled')
        raise Unauthorized()

    if not settings.GOOGLE_CLIENT_ID or not settings.ALLOWED_EMAILS:
        log.error('auth misconfigured: GOOGLE_CLIENT_ID or ALLOWED_EMAILS is empty')
        raise Unauthorized()

    try:
        claims = id_token.verify_oauth2_token(
            token, _google_request, audience=settings.GOOGLE_CLIENT_ID,
            clock_skew_in_seconds=CLOCK_SKEW_SECONDS,
        )
    except ValueError as err:  # bad signature, wrong audience, expired, malformed
        _record_failure(f'invalid token ({type(err).__name__})')
        raise Unauthorized() from None
    except Exception:  # Google's certificates could not be fetched
        log.exception('auth: token verification errored')
        raise Unauthorized() from None

    email = str(claims.get('email', '')).strip().lower()
    if claims.get('iss') not in GOOGLE_ISSUERS:
        _record_failure('issuer')
        raise Unauthorized()
    if claims.get('email_verified') is not True or not email:
        _record_failure('email not verified')
        raise Unauthorized()
    if email not in settings.ALLOWED_EMAILS:
        _record_failure('email not allowed')
        raise Unauthorized()

    ttl = int(claims.get('exp', 0) - time.time()) - CACHE_SAFETY_SECONDS
    if ttl > 0:
        cache.set(key, email, ttl)
    log.info('auth ok (new token) email=%s', email)
    return email


class GoogleIdTokenAuthentication(authentication.BaseAuthentication):
    """DRF authentication backed by verify_google_user()."""

    keyword = 'Bearer'

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).decode('latin-1')
        if not header:
            return None
        scheme, _, token = header.partition(' ')
        if scheme != self.keyword or not token:
            _record_failure('bad authorization header')
            raise Unauthorized()
        email = verify_google_user(token.strip())
        return SignedInUser(email=email), None

    def authenticate_header(self, request):
        # Makes DRF answer 401 (not 403) when the header is missing.
        return self.keyword
