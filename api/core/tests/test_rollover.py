"""Parity checks for the rollover, using the README's examples. No database needed."""

from datetime import date
from decimal import Decimal

from core.rules.jajan import JajanInput
from core.rules.rollover import (
    AUTODEDUCT, EXPENSE, INCOME, Row, autodeduct_totals, collect_candidates, jajan_net,
    jajan_rows, merge, resolve_amount, to_target_row,
)

JUL, AUG, SEP = date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)


def row(month, list_name='Groceries (sample)', type_name='Needs', amount='100000', channel='Sample Card',
        ledger=EXPENSE, installment=False, remaining=None, paid=False):
    return Row(ledger=ledger, month=month, list_name=list_name, type_name=type_name,
               amount=Decimal(amount), channel=channel, is_installment=installment,
               remaining=remaining, paid=paid)


def cicilan(month, remaining, amount='450000'):
    return row(month, list_name='Cicilan laptop (sample)', type_name='Wants', amount=amount,
               installment=True, remaining=remaining)


# --- candidates ---------------------------------------------------------------

def test_plain_rows_come_from_the_source_month_only():
    rows = [row(JUL, list_name='July item (sample)'), row(AUG, list_name='August item (sample)')]
    names = [c.list_name for c in collect_candidates(rows, EXPENSE, JUL, AUG)]
    assert names == ['July item (sample)']


def test_installment_carries_with_one_payment_less():
    rows = [cicilan(JUL, 3)]
    (candidate,) = collect_candidates(rows, EXPENSE, JUL, AUG)
    assert to_target_row(candidate, AUG, candidate.amount).remaining == 2


def test_installment_is_not_also_copied_as_a_plain_row():
    rows = [cicilan(JUL, 3)]
    assert len(collect_candidates(rows, EXPENSE, JUL, AUG)) == 1


def test_finished_installment_is_not_carried():
    rows = [cicilan(JUL, 1)]
    assert collect_candidates(rows, EXPENSE, JUL, AUG) == []


def test_jajan_rows_are_never_candidates_on_expense():
    rows = [row(JUL, list_name='Wiva', type_name='Jajan')]
    assert collect_candidates(rows, EXPENSE, JUL, AUG) == []


def test_jajan_type_is_allowed_on_other_ledgers():
    rows = [row(JUL, list_name='Wiva', type_name='Jajan', ledger='saving')]
    assert len(collect_candidates(rows, 'saving', JUL, AUG)) == 1


# --- upsert and the re-run -----------------------------------------------------

def test_running_twice_updates_the_same_row_and_adds_nothing():
    source = [row(JUL)]
    candidates = collect_candidates(source, EXPENSE, JUL, AUG)
    incoming = [to_target_row(c, AUG, c.amount) for c in candidates]
    first = merge([], incoming, EXPENSE)
    assert len(first.rows) == 1 and first.inserted

    second = merge(first.rows, incoming, EXPENSE)
    assert len(second.rows) == 1
    assert second.inserted == [] and second.updated == [0]


def test_rollover_overwrites_an_edited_amount_with_the_source_amount():
    # README: the target-month edit is overwritten when the item is still ticked on the rollover.
    edited = row(AUG, amount='150000')
    source = [row(JUL, amount='100000')]
    incoming = [to_target_row(c, AUG, c.amount) for c in collect_candidates(source, EXPENSE, JUL, AUG)]
    result = merge([edited], incoming, EXPENSE)
    assert result.rows[0].amount == Decimal('100000')


def test_a_row_added_by_hand_with_another_identity_is_left_alone():
    hand = row(AUG, list_name='Typed by hand (sample)', amount='5000')
    incoming = [to_target_row(c, AUG, c.amount) for c in collect_candidates([row(JUL)], EXPENSE, JUL, AUG)]
    result = merge([hand], incoming, EXPENSE)
    assert hand in result.rows and len(result.rows) == 2


def test_an_overridden_amount_is_written_instead_of_the_source():
    candidate = collect_candidates([row(JUL)], EXPENSE, JUL, AUG)[0]
    amount = resolve_amount(candidate, {candidate.uid: Decimal('90000')})
    assert to_target_row(candidate, AUG, amount).amount == Decimal('90000')


def test_income_matches_on_person_and_category_only():
    source = [row(JUL, list_name='Wiva', type_name='Salary (sample)', amount='10000000', ledger=INCOME)]
    incoming = [to_target_row(c, AUG, Decimal('11000000')) for c in
                collect_candidates(source, INCOME, JUL, AUG)]
    existing = [row(AUG, list_name='Wiva', type_name='Salary (sample)', amount='1', ledger=INCOME)]
    result = merge(existing, incoming, INCOME)
    assert len(result.rows) == 1 and result.rows[0].amount == Decimal('11000000')


# --- autodeduct and jajan ----------------------------------------------------

def test_autodeduct_already_on_the_sheet_is_not_counted_twice():
    existing = [row(AUG, list_name='Jajan share (sample)', type_name='Wiva', amount='220000',
                    channel='Cash', ledger=AUTODEDUCT)]
    planned = [row(AUG, list_name='Jajan share (sample)', type_name='Wiva', amount='220000',
                   channel='Cash', ledger=AUTODEDUCT)]
    assert autodeduct_totals(planned, existing)['Wiva'] == Decimal('220000')


def test_autodeduct_owner_rio_counts_as_wiva_and_unknown_owners_count_for_nobody():
    planned = [row(AUG, list_name='A', type_name='Rio', amount='10000', ledger=AUTODEDUCT),
               row(AUG, list_name='B', type_name='Someone', amount='99999', ledger=AUTODEDUCT)]
    totals = autodeduct_totals(planned, [])
    assert totals == {'Wiva': Decimal('10000'), 'Jane': Decimal(0)}


def test_jajan_rows_are_written_with_the_person_in_list():
    wiva, jane = jajan_rows(AUG, Decimal('280000'), Decimal('500000'), 'Cash', 'Cash')
    assert (wiva.list_name, wiva.type_name, wiva.amount) == ('Wiva', 'Jajan', Decimal('280000'))
    assert (jane.list_name, jane.type_name, jane.amount) == ('Jane', 'Jajan', Decimal('500000'))


def test_jajan_net_matches_the_worked_split():
    rates = JajanInput(Decimal(0), Decimal(0), Decimal(10), Decimal(50), Decimal(50))
    wiva_net, jane_net = jajan_net({'Wiva': Decimal(6_000_000), 'Jane': Decimal(4_000_000)},
                                   rates, {'Wiva': Decimal(220_000), 'Jane': Decimal(0)})
    assert (wiva_net, jane_net) == (Decimal(280_000), Decimal(500_000))
