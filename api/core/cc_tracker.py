"""CC Tracker rules that used to live in the Sheet: the J tag, the cleanup and the list filters.

The cleanup does not delete. It sets `archived`, so a row can be shown again under the "hidden"
filter. The rows still count in the monthly totals' history.
"""

from django.db.models import Q, QuerySet

from .models import CcTransaction

FILTER_ALL = 'all'
FILTER_PAID = 'paid'
FILTER_HIDDEN = 'hidden'
FILTERS = (FILTER_ALL, FILTER_PAID, FILTER_HIDDEN)

_TAGS = {
    '': ('', False),
    'cicilan': ('cicilan', False),
    'bulanan': ('bulanan', False),
    'cancelled': ('', True),
    'cancel': ('', True),
}


def parse_tag(text: str) -> tuple:
    """Turns the Sheet's J value into (kind, cancelled). Returns the same as the app stores it."""
    key = (text or '').strip().lower()
    if key not in _TAGS:
        raise ValueError(f'unknown CC tag {text!r}; use Cicilan, Bulanan, Cancelled or blank')
    return _TAGS[key]


def archive_settled() -> int:
    """Hides every paid or cancelled row that is not hidden yet. Returns how many were hidden."""
    return CcTransaction.objects.filter(Q(paid=True) | Q(cancelled=True), archived=False).update(archived=True)


def apply_filter(queryset: QuerySet, name: str) -> QuerySet:
    """All rows, paid rows, or hidden (archived) rows."""
    if name not in FILTERS:
        raise ValueError(f'unknown filter {name!r}; use {", ".join(FILTERS)}')
    if name == FILTER_PAID:
        return queryset.filter(paid=True)
    if name == FILTER_HIDDEN:
        return queryset.filter(archived=True)
    return queryset
