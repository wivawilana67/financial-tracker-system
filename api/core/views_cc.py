"""CC Tracker on the phone: the card list, the checklist (select, paid, kind, cancelled, note), and cleanup.

The cleanup hides paid and cancelled rows (archived). Nothing is deleted.
"""

import logging
from datetime import timedelta

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from . import cc_tracker
from .models import CcTransaction

log = logging.getLogger('fintrack.api.cc')
KINDS = {'', 'cicilan', 'bulanan'}


def _row_json(row: CcTransaction) -> dict:
    return {
        'id': row.id, 'datetime': row.occurred_at.isoformat(), 'bank': row.bank, 'card': row.card_masked,
        'description': row.description, 'type': row.type_name, 'amount': str(row.amount),
        'currency': row.currency, 'inbox': row.inbox, 'selected': row.selected, 'paid': row.paid,
        'kind': row.kind, 'cancelled': row.cancelled, 'note': row.note, 'archived': row.archived,
        'version': row.version,
    }


@api_view(['GET'])
def cc_list(request):
    name = request.query_params.get('filter', cc_tracker.FILTER_ALL)
    rows = CcTransaction.objects.all()
    try:
        rows = cc_tracker.apply_filter(rows, name)
    except ValueError as err:
        raise ValidationError({'filter': str(err)}) from None
    if name == cc_tracker.FILTER_ALL:
        rows = rows.filter(archived=False)  # "All" is the working list; hidden rows have their own filter
    return Response({'filter': name, 'rows': [_row_json(r) for r in rows[:500]]})


@api_view(['POST'])
def cc_update(request):
    """Body: {"rows": [{"id", "version", "selected"?, "paid"?, "kind"?, "cancelled"?, "note"?}]}.

    A row whose version does not match is skipped and reported, not overwritten.
    """
    changes = request.data.get('rows', [])
    updated, skipped = 0, []
    for item in changes:
        row = CcTransaction.objects.filter(id=item.get('id')).first()
        if row is None or row.version != item.get('version'):
            skipped.append(f"row {item.get('id')}: changed since it was loaded")
            continue
        if 'kind' in item and item['kind'] not in KINDS:
            raise ValidationError({'kind': 'use cicilan, bulanan or blank'})
        for field in ('selected', 'paid', 'cancelled'):
            if field in item:
                setattr(row, field, bool(item[field]))
        if 'kind' in item:
            row.kind = item['kind']
        if 'note' in item:
            row.note = str(item['note'])[:500]
        row.version += 1
        row.save()
        updated += 1
    return Response({'updated': updated, 'skipped': skipped})


@api_view(['POST'])
def cc_cleanup(request):
    """Hides paid and cancelled rows. Returns how many were hidden."""
    return Response({'hidden': cc_tracker.archive_settled()})


@api_view(['POST'])
def cc_restore(request):
    """Brings hidden rows back to the working list (the reverse of cleanup, one row at a time)."""
    row = CcTransaction.objects.filter(id=request.data.get('id')).first()
    if row is None:
        raise ValidationError({'id': 'no such transaction'})
    row.archived = False
    row.version += 1
    row.save()
    return Response({'id': row.id, 'archived': row.archived})
