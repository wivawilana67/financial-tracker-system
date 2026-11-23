"""Wallet (Blu Balance) on the phone: the entries, the balances per account, and version-checked edits."""

from decimal import Decimal

from rest_framework.decorators import api_view
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .models import WalletEntry
from .rules import wallet as wr
from .views_monthly import _decimal, _money

MAX_TICKS = 24


def _to_rule(entry: WalletEntry) -> wr.WalletRow:
    ticks = tuple(bool(t) for t in (entry.ticks or []))[:MAX_TICKS]
    return wr.WalletRow(price=entry.price, account=entry.account, is_income=entry.is_income, paid=entry.paid,
                        is_installment=entry.is_installment, months_total=entry.months_total, ticks=ticks)


def _json(entry: WalletEntry) -> dict:
    return {
        'id': entry.id, 'version': entry.version, 'date': entry.date.isoformat() if entry.date else None,
        'list': entry.list_usage, 'price': _money(entry.price), 'account': entry.account,
        'income': entry.is_income, 'paid': entry.paid, 'cicil': entry.is_installment,
        'months': entry.months_total, 'ticks': [bool(t) for t in (entry.ticks or [])][:MAX_TICKS],
        'instalment': _money(wr.monthly_instalment(_to_rule(entry))),
        'instalments_paid': _money(wr.instalments_paid(_to_rule(entry))),
    }


@api_view(['GET'])
def wallet_list(request):
    entries = list(WalletEntry.objects.all())
    rules = [_to_rule(e) for e in entries]
    accounts = sorted({e.account for e in entries if e.account})
    return Response({
        'rows': [_json(e) for e in entries],
        'total': _money(wr.total_wallet(rules)),
        'accounts': [{'name': a, 'balance': _money(wr.account_balance(rules, a))} for a in accounts],
    })


def _fields(item: dict) -> dict:
    ticks = [bool(t) for t in item.get('ticks', [])][:MAX_TICKS]
    ticks += [False] * (MAX_TICKS - len(ticks))
    months = item.get('months')
    if months is not None and (not isinstance(months, int) or months < 1):
        raise ValidationError({'months': 'must be a whole number of 1 or more'})
    if item.get('cicil') and not months:
        raise ValidationError({'months': 'a cicilan needs the number of months'})
    return {
        'list_usage': str(item.get('list', ''))[:200],
        'price': _decimal(item.get('price'), 'price'),
        'account': str(item.get('account', ''))[:120],
        'is_income': bool(item.get('income', False)),
        'paid': bool(item.get('paid', False)),
        'is_installment': bool(item.get('cicil', False)),
        'months_total': months,
        'ticks': ticks,
    }


@api_view(['POST'])
def wallet_add(request):
    entry = WalletEntry.objects.create(**_fields(request.data))
    return Response(_json(entry), status=201)


@api_view(['POST'])
def wallet_update(request):
    """Body: {"id", "version", ...fields}. A stale version is refused and reported."""
    entry = WalletEntry.objects.filter(id=request.data.get('id')).first()
    if entry is None:
        raise ValidationError({'id': 'no such entry'})
    if entry.version != request.data.get('version'):
        return Response({'updated': False, 'error': 'changed since it was loaded', 'row': _json(entry)}, status=409)
    for key, value in _fields(request.data).items():
        setattr(entry, key, value)
    entry.version += 1
    entry.save()
    return Response({'updated': True, 'row': _json(entry)})


@api_view(['POST'])
def wallet_delete(request):
    entry = WalletEntry.objects.filter(id=request.data.get('id')).first()
    if entry is None or entry.version != request.data.get('version'):
        return Response({'deleted': False, 'error': 'changed since it was loaded'}, status=409)
    entry.delete()
    return Response({'deleted': True})
