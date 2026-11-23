"""Monthly Data, paid status, simulation and dashboard: pure rules and the database service."""

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from core.models import IncomeEntry, LedgerEntry
from core.monthly_service import ChangeSet, LedgerAddition, LedgerDeletion, LedgerUpdate, apply_changes, dashboard_for, mark_paid
from core.rules import monthly as mr
from core.rules.jajan import JajanInput

NOV = date(2026, 11, 1)


# --- pure rules ---------------------------------------------------------------

def test_raising_an_autodeduction_takes_more_from_the_jajan_row():
    events = mr.edit_events('autodeduct', Decimal(100_000), Decimal(220_000), 'Wiva')
    new, notes = mr.apply_jajan_events(events, {'Wiva': Decimal(280_000)})
    assert new == {'Wiva': Decimal(160_000)} and notes == []


def test_deleting_an_autodeduction_hands_the_money_back():
    events = mr.edit_events('autodeduct', Decimal(220_000), None, 'Wiva')
    new, _ = mr.apply_jajan_events(events, {'Wiva': Decimal(280_000)})
    assert new == {'Wiva': Decimal(500_000)}


def test_jajan_never_goes_below_zero():
    events = mr.edit_events('autodeduct', None, Decimal(900_000), 'Jane')
    new, _ = mr.apply_jajan_events(events, {'Jane': Decimal(500_000)})
    assert new == {'Jane': Decimal(0)}


def test_no_jajan_row_means_a_note_not_a_new_row():
    events = mr.edit_events('autodeduct', None, Decimal(10_000), 'Wiva')
    new, notes = mr.apply_jajan_events(events, {})
    assert new == {} and 'No Expense / Jajan row' in notes[0]


def test_non_autodeduct_edits_do_not_touch_jajan():
    assert mr.edit_events('saving', Decimal(1), Decimal(2), 'Wiva') == []


def test_owner_rio_is_wiva_and_unknown_owners_count_for_nobody():
    assert mr.owner_of('Rio') == 'Wiva'
    assert mr.edit_events('autodeduct', None, Decimal(5), 'Someone') == []


def test_paid_marks_match_by_channel_or_by_row_ignoring_case_and_spaces():
    rows = [
        SimpleNamespace(list_name='Groceries', type_name='Needs', channel='Sample Card', paid=False),
        SimpleNamespace(list_name=' gas ', type_name='Needs', channel='Cash', paid=False),
        SimpleNamespace(list_name='Rent', type_name='Needs', channel='Cash', paid=True),
        SimpleNamespace(list_name='Other', type_name='Wants', channel='Sample Card', paid=False),
    ]
    picked = mr.rows_to_mark_paid(rows, channels={'sample card'}, events={('GAS', 'needs', 'cash')})
    assert [r.list_name for r in picked] == ['Groceries', ' gas ', 'Other']


def test_simulation_remaining_subtracts_every_part():
    left = mr.simulated_remaining(Decimal(10_000_000), Decimal(4_000_000), Decimal(2_000_000),
                                  Decimal(500_000), Decimal(300_000), Decimal(220_000))
    assert left == Decimal(2_980_000)


def test_simulated_jajan_moves_with_the_changes_and_is_clamped():
    net = mr.simulated_jajan_net({'Wiva': Decimal(280_000), 'Jane': Decimal(500_000)},
                                 gross_delta={'Wiva': Decimal(50_000)}, auto_delta={'Wiva': Decimal(400_000)})
    assert net == {'Wiva': Decimal(0), 'Jane': Decimal(500_000)}


def test_dashboard_shares_and_targets_follow_the_template_shares():
    summary = mr.dashboard(Decimal(10_000_000), {'saving': Decimal(4_000_000), 'expense': Decimal(4_000_000),
                                                 'ibadah': Decimal(500_000)},
                           autodeduct_total=Decimal(220_000), realized_autodeduct=Decimal(0))
    by_name = {s.ledger: s for s in summary['ledgers']}
    assert by_name['saving'].target == Decimal(4_000_000)
    assert by_name['expense'].target == Decimal(5_000_000)
    assert by_name['ibadah'].percent_of_income == Decimal('5.00')
    assert summary['expected_remaining'] == Decimal(9_780_000)
    assert summary['current_remaining'] == Decimal(10_000_000)


# --- database service -----------------------------------------------------------

def _jajan(owner, amount):
    return LedgerEntry.objects.create(ledger='expense', month=NOV, list_name=owner, type_name='Jajan',
                                      amount=Decimal(amount), channel='Cash')


def _auto(owner, amount, **extra):
    return LedgerEntry.objects.create(ledger='autodeduct', month=NOV, list_name='Jajan share (sample)',
                                      type_name=owner, amount=Decimal(amount), channel='Cash', **extra)


@pytest.mark.django_db
def test_adding_an_autodeduction_moves_the_jajan_row():
    _jajan('Wiva', 280_000)
    result = apply_changes(ChangeSet(month=NOV, additions=[
        LedgerAddition('autodeduct', 'Jajan share (sample)', 'Wiva', Decimal(220_000), 'Cash')]))
    assert result['added'] == 1
    assert LedgerEntry.objects.get(ledger='expense', list_name='Wiva', type_name='Jajan').amount == Decimal(60_000)


@pytest.mark.django_db
def test_a_stale_version_is_skipped_not_overwritten():
    row = _auto('Wiva', 100_000)
    result = apply_changes(ChangeSet(month=NOV, updates=[
        LedgerUpdate(id=row.id, version=99, amount=Decimal(1))]))
    assert result['updated'] == 0 and result['skipped']
    row.refresh_from_db()
    assert row.amount == Decimal(100_000)


@pytest.mark.django_db
def test_an_update_bumps_the_version_and_the_jajan_row_follows():
    _jajan('Wiva', 280_000)
    row = _auto('Wiva', 100_000)
    apply_changes(ChangeSet(month=NOV, updates=[LedgerUpdate(id=row.id, version=1, amount=Decimal(220_000))]))
    row.refresh_from_db()
    assert row.version == 2
    assert LedgerEntry.objects.get(ledger='expense', list_name='Wiva').amount == Decimal(160_000)


@pytest.mark.django_db
def test_a_deletion_returns_the_money_and_removes_the_row():
    _jajan('Wiva', 280_000)
    row = _auto('Wiva', 220_000)
    apply_changes(ChangeSet(month=NOV, deletions=[LedgerDeletion(id=row.id, version=1)]))
    assert not LedgerEntry.objects.filter(id=row.id).exists()
    assert LedgerEntry.objects.get(ledger='expense', list_name='Wiva').amount == Decimal(500_000)


@pytest.mark.django_db
def test_a_missing_jajan_row_is_reported_not_created():
    _auto('Wiva', 100_000)
    row = LedgerEntry.objects.get(ledger='autodeduct')
    result = apply_changes(ChangeSet(month=NOV, updates=[LedgerUpdate(id=row.id, version=1, amount=Decimal(200_000))]))
    assert any('No Expense / Jajan row' in s for s in result['skipped'])
    assert not LedgerEntry.objects.filter(ledger='expense').exists()


@pytest.mark.django_db
def test_negative_amounts_are_refused():
    with pytest.raises(ValueError):
        apply_changes(ChangeSet(month=NOV, additions=[
            LedgerAddition('saving', 'x', 'y', Decimal(-1))]))


@pytest.mark.django_db
def test_income_update_is_guarded_by_version():
    income = IncomeEntry.objects.create(month=NOV, person='Wiva', category='Salary (sample)', amount=Decimal(1))
    apply_changes(ChangeSet(month=NOV, income_updates=[(income.id, 9, Decimal(2))]))
    income.refresh_from_db()
    assert income.amount == Decimal(1)
    apply_changes(ChangeSet(month=NOV, income_updates=[(income.id, 1, Decimal(2))]))
    income.refresh_from_db()
    assert income.amount == Decimal(2) and income.version == 2


@pytest.mark.django_db
def test_mark_paid_by_channel_then_by_row():
    LedgerEntry.objects.create(ledger='saving', month=NOV, list_name='A', type_name='x', amount=Decimal(1),
                               channel='Sample Card')
    LedgerEntry.objects.create(ledger='ibadah', month=NOV, list_name='B', type_name='y', amount=Decimal(1),
                               channel='Cash')
    assert mark_paid(NOV, channels={'sample card'}, events=set()) == 1
    assert mark_paid(NOV, channels=set(), events={('b', 'y', 'cash')}) == 1
    assert LedgerEntry.objects.filter(paid=True).count() == 2


@pytest.mark.django_db
def test_dashboard_reads_the_month():
    IncomeEntry.objects.create(month=NOV, person='Wiva', category='Salary (sample)', amount=Decimal(10_000_000))
    LedgerEntry.objects.create(ledger='saving', month=NOV, list_name='S', type_name='x', amount=Decimal(4_000_000))
    _jajan('Wiva', 280_000)
    board = dashboard_for(NOV)
    assert board['income'] == Decimal(10_000_000)
    assert {s.ledger: s.total for s in board['ledgers']}['saving'] == Decimal(4_000_000)
    # The jajan row is not part of the Expense total: it holds the net budget, shown separately.
    assert {s.ledger: s.total for s in board['ledgers']}['expense'] == Decimal(0)
