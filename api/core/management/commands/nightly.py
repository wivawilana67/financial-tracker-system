"""The nightly Cloud Run job. Three steps, each run on its own, so one failure does not stop the others:

1. backup_db     : a backup of every table.
2. cc_sync       : yesterday's card emails, for every connected inbox.
3. draft         : on the 1st of the month only, a draft of the month's rollover. It is a summary for review;
                   nothing is written to the ledgers.

Exits with status 1 if any step failed, so the job shows as failed in Cloud Run.
"""

import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.management.base import BaseCommand

from core import backup, views_gmail
from core.cc_sync import sync_range
from core.models import MonthlyDraft
from core.rollover_service import GenerateRequest, all_candidate_uids, build_plan

log = logging.getLogger('fintrack.nightly')
JAKARTA = ZoneInfo('Asia/Jakarta')


def today_jakarta() -> date:
    return datetime.now(JAKARTA).date()


class Command(BaseCommand):
    help = 'The nightly job: backup, yesterday\'s card sync, and the 1st-of-month draft.'

    def add_arguments(self, parser):
        parser.add_argument('--today', default=None, help='Pretend today is this date (YYYY-MM-DD), for tests.')

    def handle(self, *args, **options):
        today = date.fromisoformat(options['today']) if options['today'] else today_jakarta()
        failures = []

        try:
            where = backup.run_backup()
            self.stdout.write(f'backup ok: {where}')
        except Exception:  # noqa: BLE001 - logged with traceback, then the next step runs
            log.exception('nightly: backup failed')
            failures.append('backup')

        yesterday = today - timedelta(days=1)
        try:
            report = sync_range(yesterday, yesterday, sorted(settings.ALLOWED_EMAILS), views_gmail.store())
            self.stdout.write(f'cc_sync ok: saved {report.saved} for {yesterday}')
            if any(r['status'] == 'error' for r in report.runs):
                failures.append('cc_sync (an inbox failed; see sync runs)')
        except Exception:  # noqa: BLE001
            log.exception('nightly: card sync failed')
            failures.append('cc_sync')

        if today.day == 1:
            try:
                uids = all_candidate_uids(today)
                plan = build_plan(GenerateRequest(target=today, selected=uids))
                draft = MonthlyDraft.objects.create(month=today, summary=plan.summary())
                self.stdout.write(f'draft ok: draft {draft.id} for {today:%Y-%m}')
            except Exception:  # noqa: BLE001
                log.exception('nightly: draft failed')
                failures.append('draft')

        if failures:
            log.error('nightly finished with failures: %s', ', '.join(failures))
            raise SystemExit(1)
        log.info('nightly finished ok')
