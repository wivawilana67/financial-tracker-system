"""One log line per request: method, path, status, duration and the signed-in email.

Query strings, bodies and headers are never logged, so tokens and amounts stay out of the log.
"""

import logging
import time

log = logging.getLogger('fintrack.request')


class RequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        started = time.monotonic()
        try:
            response = self.get_response(request)
        except Exception:
            log.exception('%s %s raised', request.method, request.path)
            raise
        ms = (time.monotonic() - started) * 1000
        user = request.__dict__.get('user')  # set by DRF after sign-in; never forces a lookup
        email = getattr(user, 'email', None) or '-'
        log.info('%s %s %s %.0fms user=%s', request.method, request.path, response.status_code, ms, email)
        return response
