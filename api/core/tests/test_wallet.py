from decimal import Decimal

from core.rules.wallet import WalletRow, account_balance, instalments_paid, monthly_instalment, total_wallet


def row(price, **kw):
    base = dict(price=Decimal(price), account='Bank A', is_income=False, paid=False, is_installment=False,
                months_total=None, ticks=(False,) * 24)
    base.update(kw)
    return WalletRow(**base)


def test_instalment_is_price_over_months_rounded_for_display():
    assert monthly_instalment(row('450000', is_installment=True, months_total=6)) == Decimal(75_000)


def test_instalments_paid_count_the_ticks():
    ticks = (True,) * 3 + (False,) * 21
    assert instalments_paid(row('600000', is_installment=True, months_total=6, ticks=ticks)) == Decimal(300_000)


def test_paid_income_adds_and_paid_expense_subtracts():
    rows = [row('1000000', is_income=True, paid=True), row('250000', paid=True)]
    assert account_balance(rows, 'Bank A') == Decimal(750_000)


def test_unpaid_rows_do_not_move_the_balance():
    rows = [row('1000000', is_income=True, paid=False)]
    assert account_balance(rows, 'Bank A') == Decimal(0)


def test_other_accounts_are_not_counted():
    rows = [row('1000000', is_income=True, paid=True, account='Bank B')]
    assert account_balance(rows, 'Bank A') == Decimal(0)


def test_total_wallet_is_paid_income_only():
    rows = [row('1000000', is_income=True, paid=True), row('250000', paid=True)]
    assert total_wallet(rows) == Decimal(1_000_000)
