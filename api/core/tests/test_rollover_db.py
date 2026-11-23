"""The rollover on the database: a dry run writes nothing, applying writes once, a re-run only updates."""

from datetime import date
from decimal import Decimal

import pytest

from core import fakedata
from core.models import IncomeEntry, LedgerEntry
from core.rollover_service import GenerateRequest, apply_plan, build_plan
from core.rules import rollover as ro
from core.rules.jajan import JajanInput

TARGET = date(2026, 12, 1)
SOURCE = date(2026, 11, 1)


def every_candidate_uid():
    """Ticks every candidate the rules offer, so the test covers all four ledgers."""
    uids = set()
    rows = [ro.Row(m.ledger, m.month, m.list_name, m.type_name, m.amount, m.channel,
                   m.is_installment, m.payments_remaining, m.paid)
            for m in LedgerEntry.objects.all()]
    for ledger in (ro.AUTODEDUCT, 'saving', ro.EXPENSE, 'ibadah'):
        for candidate in ro.collect_candidates(rows, ledger, SOURCE, TARGET):
            uids.add(candidate.uid)
    return uids


def request(selected):
    return GenerateRequest(
        target=TARGET,
        selected=selected,
        income={('Wiva', 'Salary (sample)'): Decimal(6_000_000), ('Jane', 'Salary (sample)'): Decimal(4_000_000)},
        jajan_base={'Wiva': Decimal(6_000_000), 'Jane': Decimal(4_000_000)},
        jajan_rates=JajanInput(Decimal(0), Decimal(0), Decimal(10), Decimal(50), Decimal(50)),
        wiva_channel='Cash', jane_channel='Cash',
    )


@pytest.fixture
def november(db):
    fakedata.seed(months=1, end=SOURCE, seed_value=5)
    return SOURCE


def test_dry_run_writes_nothing(november):
    before = LedgerEntry.objects.count()
    plan = build_plan(request(every_candidate_uid()))
    assert plan.summary()['expense']['inserted'] > 0
    assert LedgerEntry.objects.count() == before
    assert not LedgerEntry.objects.filter(month=TARGET).exists()


def test_apply_writes_the_month_and_the_jajan_rows(november):
    counts = apply_plan(build_plan(request(every_candidate_uid())))
    assert counts['inserted'] > 0
    assert LedgerEntry.objects.filter(month=TARGET, ledger='expense', list_name='Wiva', type_name='Jajan').count() == 1
    assert IncomeEntry.objects.filter(month=TARGET).count() == 2


def test_installments_carry_one_payment_less(november):
    apply_plan(build_plan(request(every_candidate_uid())))
    carried = LedgerEntry.objects.filter(month=TARGET, is_installment=True)
    assert carried.exists()
    for target in carried:
        source = LedgerEntry.objects.filter(month=SOURCE, is_installment=True, ledger=target.ledger,
                                            list_name=target.list_name, type_name=target.type_name,
                                            channel=target.channel, payments_remaining=target.payments_remaining + 1)
        assert source.exists(), f'no source row one payment ahead for {target}'
        assert target.paid is False


def test_a_second_run_updates_the_same_rows_and_adds_nothing(november):
    apply_plan(build_plan(request(every_candidate_uid())))
    count = LedgerEntry.objects.count()
    counts = apply_plan(build_plan(request(every_candidate_uid())))
    assert counts['inserted'] == 0
    assert counts['updated'] > 0
    assert LedgerEntry.objects.count() == count


def test_updated_rows_get_a_new_version(november):
    apply_plan(build_plan(request(every_candidate_uid())))
    apply_plan(build_plan(request(every_candidate_uid())))
    assert LedgerEntry.objects.filter(month=TARGET, version__gte=2).exists()


def test_target_must_be_the_first_of_the_month(november):
    bad = request(set())
    bad.target = date(2026, 12, 15)
    with pytest.raises(ValueError):
        build_plan(bad)
