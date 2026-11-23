from django.urls import path

from . import views, views_monthly

urlpatterns = [
    path('health', views.health, name='health'),
    path('health/db', views.health_db, name='health-db'),
    path('session', views.session, name='session'),
    path('dashboard', views_monthly.dashboard, name='dashboard'),
    path('simulation', views_monthly.simulation, name='simulation'),
    path('ledger', views_monthly.ledger_rows, name='ledger'),
    path('monthly/changes', views_monthly.apply_changes, name='monthly-changes'),
    path('monthly/paid', views_monthly.mark_paid, name='monthly-paid'),
    path('rollover/preview', views_monthly.rollover_preview, name='rollover-preview'),
    path('rollover/apply', views_monthly.rollover_apply, name='rollover-apply'),
]
