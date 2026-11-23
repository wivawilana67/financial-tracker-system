from django.urls import path

from . import views, views_cc, views_gmail, views_monthly, views_wallet

urlpatterns = [
    path('health', views.health, name='health'),
    path('health/db', views.health_db, name='health-db'),
    path('session', views.session, name='session'),
    path('cc', views_cc.cc_list, name='cc-list'),
    path('cc/update', views_cc.cc_update, name='cc-update'),
    path('cc/cleanup', views_cc.cc_cleanup, name='cc-cleanup'),
    path('cc/restore', views_cc.cc_restore, name='cc-restore'),
    path('wallet', views_wallet.wallet_list, name='wallet-list'),
    path('wallet/add', views_wallet.wallet_add, name='wallet-add'),
    path('wallet/update', views_wallet.wallet_update, name='wallet-update'),
    path('wallet/delete', views_wallet.wallet_delete, name='wallet-delete'),
    path('gmail/connect', views_gmail.connect, name='gmail-connect'),
    path('gmail/callback', views_gmail.callback, name='gmail-callback'),
    path('gmail/status', views_gmail.status, name='gmail-status'),
    path('cc/sync', views_gmail.manual_sync, name='cc-sync'),
    path('drafts', views_gmail.drafts, name='drafts'),
    path('drafts/confirm', views_gmail.confirm_draft, name='drafts-confirm'),
    path('dashboard', views_monthly.dashboard, name='dashboard'),
    path('simulation', views_monthly.simulation, name='simulation'),
    path('ledger', views_monthly.ledger_rows, name='ledger'),
    path('monthly/changes', views_monthly.apply_changes, name='monthly-changes'),
    path('monthly/paid', views_monthly.mark_paid, name='monthly-paid'),
    path('rollover/candidates', views_monthly.rollover_candidates, name='rollover-candidates'),
    path('rollover/preview', views_monthly.rollover_preview, name='rollover-preview'),
    path('rollover/apply', views_monthly.rollover_apply, name='rollover-apply'),
]
