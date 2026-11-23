"""Syncs card emails for a date range, for every connected inbox. Usage: manage.py cc_sync --from 2026-11-01 --to 2026-11-20"""

from datetime import date

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core import views_gmail
from core.cc_sync import sync_range


class Command(BaseCommand):
    help = 'Syncs the card notification emails for a date range.'

    def add_arguments(self, parser):
        parser.add_argument('--from', dest='start', required=True, help='First day, YYYY-MM-DD (Jakarta).')
        parser.add_argument('--to', dest='end', required=True, help='Last day, YYYY-MM-DD (Jakarta).')

    def handle(self, *args, **options):
        try:
            start, end = date.fromisoformat(options['start']), date.fromisoformat(options['end'])
        except ValueError:
            raise CommandError('dates must look like YYYY-MM-DD') from None
        report = sync_range(start, end, sorted(settings.ALLOWED_EMAILS), views_gmail.store())
        for run in report.runs:
            self.stdout.write(f"{run['inbox']} {run['bank']}: {run['status']}, saved {run['saved']}")
        self.stdout.write(f'Saved {report.saved} new transaction(s).')
