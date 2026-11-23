"""Parity checks for the monthly rules, using the examples written in the README."""

from datetime import date
from decimal import Decimal

from core.rules import installments as inst
from core.rules.installments import InstallmentState
from core.rules.jajan import JajanInput, allocate

KEY = ('Cicilan HP (sample)', 'Needs', 'Sample Card')


def state(month, remaining, amount='100000'):
    return InstallmentState(key=KEY, month=month, remaining=remaining, amount=Decimal(amount))


# --- installments: the README's worked example -------------------------------

def test_generate_august_from_july_writes_two_left():
    rows = [state(date(2026, 7, 1), 3)]
    assert inst.carry_forward(rows, date(2026, 8, 1)) == {KEY: 2}


def test_running_august_again_gives_the_same_answer():
    rows = [state(date(2026, 7, 1), 3)]
    assert inst.carry_forward(rows, date(2026, 8, 1)) == inst.carry_forward(rows, date(2026, 8, 1))


def test_september_from_august_writes_one_left():
    rows = [state(date(2026, 7, 1), 3), state(date(2026, 8, 1), 2)]
    assert inst.carry_forward(rows, date(2026, 9, 1)) == {KEY: 1}


def test_october_from_september_is_finished_so_nothing_is_written():
    rows = [state(date(2026, 7, 1), 3), state(date(2026, 8, 1), 2), state(date(2026, 9, 1), 1)]
    assert inst.carry_forward(rows, date(2026, 10, 1)) == {}


def test_august_again_after_september_and_october_exist_ignores_later_rows():
    rows = [state(date(2026, 7, 1), 3), state(date(2026, 8, 1), 2),
            state(date(2026, 9, 1), 1), state(date(2026, 10, 1), 0)]
    assert inst.carry_forward(rows, date(2026, 8, 1)) == {KEY: 2}


# --- installments: pauses and restructures ------------------------------------

def test_a_paused_installment_resumes_from_its_last_state():
    # July has 5 left; August to October are skipped; November writes 4 left at July's amount.
    rows = [state(date(2026, 7, 1), 5)]
    assert inst.carry_forward(rows, date(2026, 11, 1)) == {KEY: 4}


def test_a_restructure_uses_the_latest_month_even_if_the_count_went_up():
    rows = [state(date(2026, 7, 1), 2), state(date(2026, 8, 1), 9)]
    assert inst.carry_forward(rows, date(2026, 9, 1)) == {KEY: 8}


def test_two_rows_in_the_same_month_take_the_smaller_count():
    rows = [state(date(2026, 7, 1), 4), state(date(2026, 7, 1), 2)]
    assert inst.carry_forward(rows, date(2026, 8, 1)) == {KEY: 1}


def test_rows_on_or_after_the_target_month_are_never_read():
    rows = [state(date(2026, 8, 1), 1)]
    assert inst.carry_forward(rows, date(2026, 8, 1)) == {}


# --- jajan allocation --------------------------------------------------------

def jajan_input(wiva_base, jane_base, pool=10, wiva=50, jane=50):
    return JajanInput(Decimal(wiva_base), Decimal(jane_base), Decimal(pool), Decimal(wiva), Decimal(jane))


def test_jajan_split_takes_autodeductions_out_of_each_share():
    # Combined income 10,000,000 -> pool 1,000,000 -> 500,000 each.
    result = allocate(jajan_input(6_000_000, 4_000_000), Decimal(220_000), Decimal(0))
    assert result.gross_pool == Decimal(1_000_000)
    assert result.wiva_net == Decimal(280_000)
    assert result.jane_net == Decimal(500_000)


def test_jajan_never_goes_below_zero():
    result = allocate(jajan_input(6_000_000, 4_000_000), Decimal(900_000), Decimal(0))
    assert result.wiva_net == Decimal(0)


def test_jajan_rounds_half_up_to_whole_rupiah():
    # Combined 1,000,010 -> pool 100,001 -> Wiva's 50% is 50,000.5, which rounds up to 50,001.
    result = allocate(jajan_input(1_000_010, 0), Decimal(0), Decimal(0))
    assert result.gross_pool == Decimal(100_001)
    assert result.wiva_net == Decimal(50_001)
    # Combined 1,000,000 -> Wiva's 50% is 50,000.0 exactly: no rounding needed.
    exact = allocate(jajan_input(1_000_000, 0), Decimal(0), Decimal(0))
    assert exact.wiva_net == Decimal(50_000)


def test_jajan_with_no_income_is_zero():
    result = allocate(jajan_input(0, 0), Decimal(0), Decimal(0))
    assert (result.wiva_net, result.jane_net) == (Decimal(0), Decimal(0))
