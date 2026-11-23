"""One JSON error shape for the whole API: {"error": "<message>"}.

Sign-in problems always say just "Unauthorized". Unexpected exceptions are logged with their
traceback and answered with a generic 500, so internals never reach the phone.
"""

import logging

from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler

log = logging.getLogger('fintrack.errors')


def api_exception_handler(exc, context):
    view = context.get('view')
    where = type(view).__name__ if view else 'unknown view'

    if isinstance(exc, (exceptions.NotAuthenticated, exceptions.AuthenticationFailed)):
        response = exception_handler(exc, context)  # keeps the WWW-Authenticate header
        response.data = {'error': 'Unauthorized'}
        return response
    if isinstance(exc, exceptions.PermissionDenied):
        return Response({'error': 'Unauthorized'}, status=status.HTTP_403_FORBIDDEN)

    response = exception_handler(exc, context)
    if response is not None:
        data = response.data
        if isinstance(data, dict) and 'detail' in data:
            response.data = {'error': str(data['detail'])}
        else:  # field validation errors
            response.data = {'error': 'Invalid request', 'fields': data}
        log.info('%s answered %s: %s', where, response.status_code, response.data['error'])
        return response

    log.exception('%s raised an unexpected error', where)
    return Response({'error': 'Server error'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
