"""Gmail connection and the manual card sync.

Connect: the app asks for a consent link while signed in; Google sends the browser back to
/api/gmail/callback, which is not signed in with a header (a browser redirect cannot carry one). That
callback trusts only a state value this server signed, and only for the email that asked for it.
"""

import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core import signing
from django.http import HttpResponseRedirect
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from . import gmail_auth
from .cc_sync import sync_range
from .models import MonthlyDraft, ParseFailure, SyncRun

log = logging.getLogger('fintrack.api.gmail')
STATE_SALT = 'fintrack.gmail.connect'
STATE_MAX_AGE = 600
JAKARTA = ZoneInfo('Asia/Jakarta')
_store = None


def store():
    global _store
    if _store is None:
        _store = gmail_auth.default_store()
    return _store


def _app_home() -> str:
    return settings.GMAIL_REDIRECT_URI.rsplit('/api/', 1)[0] + '/'


@api_view(['GET'])
def connect(request):
    """A consent link for the signed-in owner's own inbox."""
    if not settings.GMAIL_CLIENT_ID or not settings.GMAIL_REDIRECT_URI:
        raise ValidationError({'gmail': 'Gmail connection is not configured'})
    state = signing.dumps({'email': request.user.email}, salt=STATE_SALT)
    return Response({'url': gmail_auth.consent_url(state)})


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def callback(request):
    """Google's redirect. Stores the refresh token and sends the browser back to the app."""
    try:
        claims = signing.loads(request.query_params.get('state', ''), salt=STATE_SALT, max_age=STATE_MAX_AGE)
    except signing.BadSignature:
        log.warning('gmail callback refused: state missing, expired or altered')
        return HttpResponseRedirect(_app_home() + '?gmail=error')
    if request.query_params.get('error') or not request.query_params.get('code'):
        return HttpResponseRedirect(_app_home() + '?gmail=denied')
    email = claims.get('email', '')
    if email not in settings.ALLOWED_EMAILS:
        log.warning('gmail callback refused: email is not on the allowlist')
        return HttpResponseRedirect(_app_home() + '?gmail=error')
    try:
        token = gmail_auth.exchange_code(request.query_params['code'])
        store().put(email, token)
    except Exception:  # any failure: logged with its traceback; the browser only gets a plain answer
        log.exception('gmail connect failed')
        return HttpResponseRedirect(_app_home() + '?gmail=error')
    log.info('gmail inbox connected')
    return HttpResponseRedirect(_app_home() + '?gmail=connected')


@api_view(['GET'])
def status(request):
    """Whether the signed-in owner's inbox is connected, and the recent runs and failures."""
    mine = request.user.email
    runs = SyncRun.objects.all()[:10]
    failures = ParseFailure.objects.filter(resolved=False)[:20]
    return Response({
        'inbox': mine,
        'connected': bool(store().get(mine)) if mine in settings.ALLOWED_EMAILS else False,
        'runs': [{'when': r.started_at.isoformat(), 'inbox': r.inbox, 'bank': r.bank, 'status': r.status,
                  'found': r.found, 'saved': r.saved, 'failed': r.failed, 'note': r.note} for r in runs],
        'failures': [{'when': f.received.isoformat(), 'inbox': f.inbox, 'reason': f.reason} for f in failures],
    })


@api_view(['POST'])
def manual_sync(request):
    """Sync Today, Sync Yesterday or a custom range. Syncs every connected inbox."""
    try:
        start = date.fromisoformat(str(request.data.get('start', '')))
        end = date.fromisoformat(str(request.data.get('end', '')))
    except ValueError:
        raise ValidationError({'range': 'use YYYY-MM-DD for start and end'}) from None
    if end < start or (end - start).days > 92:
        raise ValidationError({'range': 'end must not be before start, and the range is at most 93 days'})
    report = sync_range(start, end, sorted(settings.ALLOWED_EMAILS), store())
    return Response({'saved': report.saved, 'runs': report.runs})


@api_view(['GET'])
def drafts(request):
    """The nightly drafts, newest first. A draft is a summary; confirming it does not write anything."""
    rows = MonthlyDraft.objects.all()[:12]
    return Response({'drafts': [{'id': d.id, 'month': d.month.isoformat(), 'created': d.created_at.isoformat(),
                                 'summary': d.summary, 'confirmed': d.confirmed} for d in rows]})


@api_view(['POST'])
def confirm_draft(request):
    """Marks a draft as reviewed. The rollover itself is run from the Generate screen."""
    draft = MonthlyDraft.objects.filter(id=request.data.get('id')).first()
    if draft is None:
        raise ValidationError({'id': 'no such draft'})
    draft.confirmed = True
    draft.save(update_fields=['confirmed'])
    return Response({'id': draft.id, 'confirmed': True})
