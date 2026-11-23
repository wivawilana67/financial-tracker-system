"""Health checks and the session endpoint."""

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import connection
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

log = logging.getLogger('fintrack.views')

LEDGER_TZ = ZoneInfo(settings.TIME_ZONE)


def current_month_key(now=None):
    """'YYYY-MM' of today in the ledgers' time zone (Asia/Jakarta), like currentMonthKey() in Common.js."""
    return (now or datetime.now(LEDGER_TZ)).astimezone(LEDGER_TZ).strftime('%Y-%m')


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def health(request):
    """Public: proves the request reached Django. Never touches the database."""
    return Response({'status': 'ok', 'env': settings.APP_ENV, 'version': settings.APP_VERSION})


@api_view(['GET'])
def health_db(request):
    """Signed-in only: proves Django can reach the database (wakes Neon if it was asleep)."""
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
            cursor.fetchone()
    except Exception:
        log.exception('health_db: database unreachable')
        return Response({'status': 'error', 'database': 'unreachable'}, status=503)
    return Response({'status': 'ok', 'database': connection.vendor})


@api_view(['GET'])
def session(request):
    """Who is signed in, which environment this is, and the current ledger month."""
    return Response({'email': request.user.email, 'env': settings.APP_ENV, 'month': current_month_key()})
