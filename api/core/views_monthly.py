"""Phone API for the monthly screens: dashboard, simulation, ledger rows, edits, paid marks and the rollover.

All routes sit under /api/ and need a Google sign-in (DRF's default permission). Amounts travel as
strings, so no rupiah value passes through a float. Every write returns what changed, and a
stale edit is reported in `skipped`, never applied.
"""

import logging
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from . import monthly_service as ms
from .models import IncomeEntry, LedgerEntry
from .rollover_service import GenerateRequest, apply_plan, build_plan
from .rules import rollover as ro
from .rules.jajan import JajanInput

log = logging.getLogger('fintrack.api.monthly')
LEDGERS = ('saving', 'expense', 'ibadah', 'autodeduct')


def _month(value) -> date:
    try:
        parsed = date.fromisoformat(f'{value}-01') if isinstance(value, str) and len(value) == 7 else None
    except ValueError:
        parsed = None
    if parsed is None:
        raise ValidationError({'month': 'use YYYY-MM'})
    return parsed


def _decimal(value, field: str, allow_negative: bool = False) -> Decimal:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError({field: 'not a number'}) from None
    if not amount.is_finite() or (not allow_negative and amount < 0):
        raise ValidationError({field: 'must be zero or more'})
    return amount.quantize(Decimal('0.01'))


def _money(value) -> str:
    return str(Decimal(value).quantize(Decimal('0.01')))


def _ledger_json(row: LedgerEntry) -> dict:
    return {'id': row.id, 'version': row.version, 'ledger': row.ledger, 'list': row.list_name,
            'type': row.type_name, 'amount': _money(row.amount), 'channel': row.channel,
            'cicilan': row.is_installment, 'remaining': row.payments_remaining, 'paid': row.paid}


@api_view(['GET'])
def dashboard(request):
    month = _month(request.query_params.get('month'))
    board = ms.dashboard_for(month)
    return Response({
        'month': month.isoformat(),
        'income': _money(board['income']),
        'ledgers': [{'ledger': s.ledger, 'total': _money(s.total),
                     'percent_of_income': str(s.percent_of_income), 'target': _money(s.target),
                     'to_target_percent': str(s.to_target_percent)} for s in board['ledgers']],
        'expected_remaining': _money(board['expected_remaining']),
        'current_remaining': _money(board['current_remaining']),
    })


@api_view(['GET'])
def simulation(request):
    month = _month(request.query_params.get('month'))
    adjustments = {}
    for key in ('income', 'saving', 'expense', 'ibadah', 'autodeduct'):
        if key in request.query_params:
            adjustments[key] = _decimal(request.query_params[key], key)
    result = ms.simulation_for(month, adjustments)
    return Response({
        'month': month.isoformat(),
        **{k: _money(v) for k, v in result.items() if k != 'jajan_net'},
        'jajan_net': {owner: _money(v) for owner, v in result['jajan_net'].items()},
    })


@api_view(['GET'])
def ledger_rows(request):
    month = _month(request.query_params.get('month'))
    ledger = request.query_params.get('ledger')
    rows = LedgerEntry.objects.filter(month=month)
    if ledger:
        if ledger not in LEDGERS:
            raise ValidationError({'ledger': f'use one of {", ".join(LEDGERS)}'})
        rows = rows.filter(ledger=ledger)
    income = IncomeEntry.objects.filter(month=month)
    return Response({
        'month': month.isoformat(),
        'rows': [_ledger_json(r) for r in rows],
        'income': [{'id': i.id, 'version': i.version, 'person': i.person, 'category': i.category,
                    'amount': _money(i.amount)} for i in income] if not ledger else [],
    })


@api_view(['POST'])
def apply_changes(request):
    body = request.data
    month = _month(body.get('month'))
    change = ms.ChangeSet(month=month)
    for item in body.get('updates', []):
        change.updates.append(ms.LedgerUpdate(
            id=int(item['id']), version=int(item['version']), amount=_decimal(item['amount'], 'amount'),
            channel=item.get('channel'), is_installment=bool(item.get('cicilan', False)),
            remaining=item.get('remaining'), paid=bool(item.get('paid', False))))
    for item in body.get('deletions', []):
        change.deletions.append(ms.LedgerDeletion(id=int(item['id']), version=int(item['version'])))
    for item in body.get('additions', []):
        if item.get('ledger') not in LEDGERS:
            raise ValidationError({'ledger': 'unknown ledger'})
        change.additions.append(ms.LedgerAddition(
            ledger=item['ledger'], list_name=item.get('list', ''), type_name=item.get('type', ''),
            amount=_decimal(item['amount'], 'amount'), channel=item.get('channel', ''),
            is_installment=bool(item.get('cicilan', False)), remaining=item.get('remaining'),
            paid=bool(item.get('paid', False))))
    for item in body.get('income', []):
        change.income_updates.append((int(item['id']), int(item['version']),
                                      _decimal(item['amount'], 'amount')))
    try:
        result = ms.apply_changes(change)
    except ValueError as err:
        raise ValidationError({'changes': str(err)}) from None
    return Response(result)


@api_view(['POST'])
def mark_paid(request):
    month = _month(request.data.get('month'))
    channels = set(request.data.get('channels', []))
    events = {tuple(e) for e in request.data.get('rows', [])}
    return Response({'marked': ms.mark_paid(month, channels, events)})


def _rollover_request(body) -> GenerateRequest:
    rates = body.get('jajan_rates', {})
    base = body.get('jajan_base', {})
    return GenerateRequest(
        target=_month(body.get('month')),
        selected=set(body.get('selected', [])),
        overrides={k: _decimal(v, 'overrides') for k, v in body.get('overrides', {}).items()},
        income={(item['person'], item['category']): _decimal(item['amount'], 'income')
                for item in body.get('income', [])},
        jajan_base={'Wiva': _decimal(base.get('Wiva', 0), 'jajan_base'),
                    'Jane': _decimal(base.get('Jane', 0), 'jajan_base')},
        jajan_rates=JajanInput(Decimal(0), Decimal(0), _decimal(rates.get('pool', 10), 'pool'),
                               _decimal(rates.get('wiva', 50), 'wiva'), _decimal(rates.get('jane', 50), 'jane')),
        wiva_channel=body.get('wiva_channel', ''), jane_channel=body.get('jane_channel', ''),
    )


def _plan_json(plan) -> dict:
    return {'month': plan.target.isoformat(), 'summary': plan.summary(),
            'autodeduct_totals': {k: _money(v) for k, v in plan.autodeduct_totals.items()},
            'jajan_net': {k: _money(v) for k, v in plan.jajan_net.items()}}


@api_view(['POST'])
def rollover_preview(request):
    """Dry run: what the generation would write. Nothing is saved."""
    plan = build_plan(_rollover_request(request.data))
    return Response(_plan_json(plan))


@api_view(['POST'])
def rollover_apply(request):
    """Writes the generation. Only call after the preview has been reviewed."""
    plan = build_plan(_rollover_request(request.data))
    counts = apply_plan(plan)
    return Response({**_plan_json(plan), 'written': counts}, status=status.HTTP_200_OK)


@api_view(['GET'])
def rollover_candidates(request):
    """The rows last month's generation would offer, with what each would write for the target month."""
    target = _month(request.query_params.get('month'))
    source = (target - timedelta(days=1)).replace(day=1)
    rows = [ro.Row(m.ledger, m.month, m.list_name, m.type_name, m.amount, m.channel,
                   m.is_installment, m.payments_remaining, m.paid)
            for m in LedgerEntry.objects.filter(month__lte=target)]
    offered = []
    for ledger in ('autodeduct', 'saving', 'expense', 'ibadah'):
        for candidate in ro.collect_candidates(rows, ledger, source, target):
            written = ro.to_target_row(candidate, target, candidate.amount)
            offered.append({
                'uid': candidate.uid, 'ledger': ledger, 'list': candidate.list_name,
                'type': candidate.type_name, 'channel': candidate.channel,
                'amount': _money(candidate.amount), 'cicilan': candidate.is_installment,
                'remaining_after': written.remaining,
            })
    return Response({'month': target.isoformat(), 'source': source.isoformat(), 'candidates': offered})
