"""Phase 2 data model: the ledgers, income, and the card transaction log.

Parity with the Sheet is the goal, so the columns keep the Sheet's meaning:
- `month` is always the first day of the month a row belongs to (column A, `yyyy-MM-01`).
- `list_name`, `type_name` and `channel` are the same text the Sheet uses; the rollover
  identity is List + Type + Note/Channel (see README, "Generate Monthly Data flow").
- Money is `Decimal` (rupiah, no float rounding).

Wallet (Blu Balance) and the rule engine come in later steps of phase 2 and phase 3.
"""

from django.db import models
from django.db.models import Q


class Ledger(models.TextChoices):
    """The four ledger sheets that share the eight-column layout."""

    SAVING = 'saving', 'Saving'
    EXPENSE = 'expense', 'Expense'
    IBADAH = 'ibadah', 'Ibadah'
    AUTODEDUCT = 'autodeduct', 'Autodeduct Jajan'


class Person(models.TextChoices):
    """People with an income box and a jajan budget (INCOME_PERSONS in MonthlyGeneration.js)."""

    WIVA = 'Wiva', 'Wiva'
    JANE = 'Jane', 'Jane'


class LedgerEntry(models.Model):
    ledger = models.CharField(max_length=16, choices=Ledger.choices)
    month = models.DateField(help_text='First day of the month this row belongs to.')
    list_name = models.CharField('list', max_length=200)
    type_name = models.CharField('type', max_length=120, blank=True)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    channel = models.CharField('note / channel', max_length=120, blank=True)
    is_installment = models.BooleanField('cicilan', default=False)
    payments_remaining = models.PositiveIntegerField(null=True, blank=True)
    paid = models.BooleanField('sudah bayar', default=False)
    # Incremented on every write. The API refuses an edit whose version is stale (audit rule D26).
    version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ['month', 'ledger', 'type_name', 'channel', 'list_name']
        indexes = [models.Index(fields=['month', 'ledger'])]
        constraints = [
            models.CheckConstraint(condition=Q(month__day=1), name='ledger_month_first_day'),
            models.CheckConstraint(
                condition=Q(payments_remaining__isnull=True) | Q(is_installment=True),
                name='remaining_only_for_installments',
            ),
        ]

    def __str__(self):
        return f'{self.month:%Y-%m} {self.get_ledger_display()}: {self.list_name} {self.amount}'


class IncomeEntry(models.Model):
    month = models.DateField(help_text='First day of the month this row belongs to.')
    person = models.CharField(max_length=20, choices=Person.choices)
    category = models.CharField(max_length=120)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ['month', 'person', 'category']
        indexes = [models.Index(fields=['month'])]
        constraints = [
            models.CheckConstraint(condition=Q(month__day=1), name='income_month_first_day'),
        ]

    def __str__(self):
        return f'{self.month:%Y-%m} {self.person} {self.category} {self.amount}'


class WalletEntry(models.Model):
    """One row of the Blu Balance tab. Totals and remaining counts are computed by the app, not stored."""

    date = models.DateField(null=True, blank=True)
    list_usage = models.CharField('list usage', max_length=200)
    price = models.DecimalField(max_digits=16, decimal_places=2)
    account = models.CharField(max_length=120, blank=True)
    is_income = models.BooleanField('income?', default=False)
    paid = models.BooleanField('sudah bayar?', default=False)
    is_installment = models.BooleanField('cicil?', default=False)
    months_total = models.PositiveIntegerField('bulan', null=True, blank=True)
    # The 24 tick boxes (columns 1..24): ticks[0] is installment 1, and so on.
    ticks = models.JSONField(default=list, blank=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ['date', 'id']

    def __str__(self):
        return f'{self.date or "-"} {self.list_usage} {self.price}'


class CcTransaction(models.Model):
    """Every card transaction synced from the bank emails (the permanent CC Transaction log)."""

    occurred_at = models.DateTimeField('datetime')
    bank = models.CharField(max_length=40)
    card_masked = models.CharField('card number', max_length=32)
    description = models.CharField(max_length=300)
    type_name = models.CharField('type', max_length=120, blank=True)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    currency = models.CharField(max_length=8, default='IDR')
    inbox = models.CharField(max_length=254, help_text='Which connected Gmail inbox the email came from.')
    # Hash of the seven columns above. A second sync of the same email adds nothing (see fingerprint.py).
    fingerprint = models.CharField(max_length=64, unique=True)
    # CC Tracker checklist state: the H (select), I (paid), J (tag) and K (note) columns.
    # J holds one tag: cicilan or bulanan says what the row is; cancelled marks it for removal.
    selected = models.BooleanField(default=False)
    paid = models.BooleanField(default=False)
    kind = models.CharField(max_length=16, blank=True, choices=[('cicilan', 'Cicilan'), ('bulanan', 'Bulanan')])
    cancelled = models.BooleanField(default=False)
    note = models.CharField(max_length=500, blank=True)
    # The cleanup hides paid and cancelled rows by setting this flag. Nothing is deleted.
    archived = models.BooleanField(default=False)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ['occurred_at', 'id']
        indexes = [models.Index(fields=['occurred_at'])]

    def __str__(self):
        return f'{self.occurred_at:%Y-%m-%d %H:%M} {self.bank} {self.description} {self.amount}'


class SyncRun(models.Model):
    """One card sync, per inbox and bank: what was found, saved and failed."""

    started_at = models.DateTimeField(auto_now_add=True)
    inbox = models.CharField(max_length=254)
    bank = models.CharField(max_length=40)
    range_start = models.DateField()
    range_end = models.DateField()
    found = models.PositiveIntegerField(default=0)
    saved = models.PositiveIntegerField(default=0)
    failed = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=20, default='ok')  # ok, skipped, error
    note = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ['-started_at']


class ParseFailure(models.Model):
    """A card email the parser could not read. The email's text is not kept, only the date and reason."""

    created_at = models.DateTimeField(auto_now_add=True)
    inbox = models.CharField(max_length=254)
    bank = models.CharField(max_length=40)
    received = models.DateTimeField()
    reason = models.CharField(max_length=200)
    resolved = models.BooleanField(default=False)

    class Meta:
        ordering = ['-received']


class MonthlyDraft(models.Model):
    """The nightly job's suggestion for the month: a summary only. Nothing is written to the ledgers."""

    created_at = models.DateTimeField(auto_now_add=True)
    month = models.DateField()
    summary = models.JSONField(default=dict)
    confirmed = models.BooleanField(default=False)

    class Meta:
        ordering = ['-created_at']
