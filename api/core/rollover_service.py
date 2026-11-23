"""Generate Monthly Data, on the database.

Loads the stored rows, runs the rules in core/rules/rollover.py, and (only when apply=True) writes
the result in one transaction. A dry run returns the same plan without writing anything, so it can
be shown to the user before they confirm.

Ledger rows are updated in place (version + 1) and new rows are inserted, exactly as the Sheet's
upsert does. Rows that are not touched are never rewritten.
"""

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction

from .models import IncomeEntry, LedgerEntry
from .rules import rollover as ro
from .rules.jajan import JajanInput

log = logging.getLogger('fintrack.rollover')

LEDGERS = (ro.AUTODEDUCT, 'saving', ro.EXPENSE, 'ibadah')  # Autodeduct first: the jajan budget needs it


@dataclass
class GenerateRequest:
    target: date
    selected: set                       # candidate uids ticked on the rollover tab
    overrides: dict = field(default_factory=dict)   # uid -> Decimal
    income: dict = field(default_factory=dict)      # (person, category) -> Decimal, the target-month boxes
    jajan_base: dict = field(default_factory=dict)  # person -> Decimal, income in the counted categories
    jajan_rates: JajanInput | None = None           # only the rate fields are read
    wiva_channel: str = ''
    jane_channel: str = ''


@dataclass
class Plan:
    target: date
    merges: dict = field(default_factory=dict)       # ledger -> MergeResult
    income: object = None                            # MergeResult
    autodeduct_totals: dict = field(default_factory=dict)
    jajan_net: dict = field(default_factory=dict)
    existing: dict = field(default_factory=dict)     # ledger -> model objects, same order as merge rows

    def summary(self) -> dict:
        return {
            ledger: {'updated': len(m.updated), 'inserted': len(m.inserted)}
            for ledger, m in self.merges.items()
        } | {'income': {'updated': len(self.income.updated), 'inserted': len(self.income.inserted)}}


def _to_row(model) -> ro.Row:
    return ro.Row(ledger=model.ledger, month=model.month, list_name=model.list_name,
                  type_name=model.type_name, amount=model.amount, channel=model.channel,
                  is_installment=model.is_installment, remaining=model.payments_remaining, paid=model.paid)


def _to_model(row: ro.Row) -> LedgerEntry:
    return LedgerEntry(ledger=row.ledger, month=row.month, list_name=row.list_name, type_name=row.type_name,
                       amount=row.amount, channel=row.channel, is_installment=row.is_installment,
                       payments_remaining=row.remaining, paid=row.paid)


def build_plan(req: GenerateRequest) -> Plan:
    if req.target.day != 1:
        raise ValueError('target must be the first day of the month')
    source = (req.target - timedelta(days=1)).replace(day=1)
    stored = list(LedgerEntry.objects.filter(month__lte=req.target).order_by('month', 'ledger', 'id'))
    all_rows = [_to_row(m) for m in stored]
    plan = Plan(target=req.target)

    # The target month's own rows, per ledger, in stored order.
    for ledger in LEDGERS:
        plan.existing[ledger] = [m for m in stored if m.ledger == ledger and m.month == req.target]

    # Autodeduct first: its planned rows and the rows already there give each person's deduction.
    planned_autodeduct = []
    for candidate in ro.collect_candidates(all_rows, ro.AUTODEDUCT, source, req.target):
        if candidate.uid in req.selected:
            planned_autodeduct.append(ro.to_target_row(candidate, req.target,
                                                       ro.resolve_amount(candidate, req.overrides)))
    existing_autodeduct = [_to_row(m) for m in plan.existing[ro.AUTODEDUCT]]
    plan.autodeduct_totals = ro.autodeduct_totals(planned_autodeduct, existing_autodeduct)

    planned = {ro.AUTODEDUCT: planned_autodeduct}
    for ledger in ('saving', ro.EXPENSE, 'ibadah'):
        planned[ledger] = []
        for candidate in ro.collect_candidates(all_rows, ledger, source, req.target):
            if candidate.uid in req.selected:
                planned[ledger].append(ro.to_target_row(candidate, req.target,
                                                        ro.resolve_amount(candidate, req.overrides)))

    if req.jajan_rates is not None:
        wiva_net, jane_net = ro.jajan_net(
            {'Wiva': req.jajan_base.get('Wiva', Decimal(0)), 'Jane': req.jajan_base.get('Jane', Decimal(0))},
            req.jajan_rates, plan.autodeduct_totals)
        plan.jajan_net = {'Wiva': wiva_net, 'Jane': jane_net}
        planned[ro.EXPENSE].extend(ro.jajan_rows(req.target, wiva_net, jane_net,
                                                 req.wiva_channel, req.jane_channel))

    for ledger in LEDGERS:
        existing = [_to_row(m) for m in plan.existing[ledger]]
        plan.merges[ledger] = ro.merge(existing, planned[ledger], ledger)

    stored_income = list(IncomeEntry.objects.filter(month=req.target).order_by('id'))
    income_rows = [ro.Row(ro.INCOME, req.target, person, category, amount)
                   for (person, category), amount in req.income.items()]
    plan.income = ro.merge([ro.Row(ro.INCOME, m.month, m.person, m.category, m.amount) for m in stored_income],
                           income_rows, ro.INCOME)
    plan.existing[ro.INCOME] = stored_income
    return plan


def apply_plan(plan: Plan) -> dict:
    """Writes the plan in one transaction. Updated rows get version + 1; untouched rows are not written."""
    counts = {'updated': 0, 'inserted': 0}
    with transaction.atomic():
        for ledger, merge in plan.merges.items():
            models = plan.existing[ledger]
            for i in merge.updated:
                model = models[i]
                updated = merge.rows[i]
                model.amount = updated.amount
                model.is_installment = updated.is_installment
                model.payments_remaining = updated.remaining
                model.paid = updated.paid
                model.version += 1
                model.save(update_fields=['amount', 'is_installment', 'payments_remaining', 'paid', 'version'])
                counts['updated'] += 1
            if merge.inserted:
                LedgerEntry.objects.bulk_create([_to_model(r) for r in merge.inserted])
                counts['inserted'] += len(merge.inserted)
        for i in plan.income.updated:
            model = plan.existing[ro.INCOME][i]
            model.amount = plan.income.rows[i].amount
            model.version += 1
            model.save(update_fields=['amount', 'version'])
            counts['updated'] += 1
        if plan.income.inserted:
            IncomeEntry.objects.bulk_create([
                IncomeEntry(month=r.month, person=r.list_name, category=r.type_name, amount=r.amount)
                for r in plan.income.inserted])
            counts['inserted'] += len(plan.income.inserted)
    log.info('rollover applied target=%s updated=%s inserted=%s', plan.target, counts['updated'], counts['inserted'])
    return counts
