from django.contrib import admin

from .models import CcTransaction, IncomeEntry, LedgerEntry


@admin.register(LedgerEntry)
class LedgerEntryAdmin(admin.ModelAdmin):
    list_display = ('month', 'ledger', 'list_name', 'type_name', 'amount', 'channel', 'paid')
    list_filter = ('ledger', 'month', 'paid', 'is_installment')
    search_fields = ('list_name', 'type_name', 'channel')
    date_hierarchy = 'month'


@admin.register(IncomeEntry)
class IncomeEntryAdmin(admin.ModelAdmin):
    list_display = ('month', 'person', 'category', 'amount')
    list_filter = ('person', 'month')
    search_fields = ('category',)


@admin.register(CcTransaction)
class CcTransactionAdmin(admin.ModelAdmin):
    list_display = ('occurred_at', 'bank', 'description', 'amount', 'inbox', 'paid', 'cancelled')
    list_filter = ('bank', 'paid', 'cancelled', 'inbox')
    search_fields = ('description', 'card_masked')
    readonly_fields = ('fingerprint',)
    date_hierarchy = 'occurred_at'
