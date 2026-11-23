"""Imports a CSV exported from one Sheet tab.

Dry run by default: it reads and checks the file, prints what it found, and writes nothing.
Add --commit to save. Export each tab from Google Sheets as CSV (File → Download → CSV).
The wallet export is the whole Blu Balance tab; the importer skips its summary rows above the header.
"""

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core import importers
from core.models import Ledger, WalletEntry


class Command(BaseCommand):
    help = 'Imports one Sheet tab exported as CSV. Dry run unless --commit is given.'

    def add_arguments(self, parser):
        parser.add_argument('kind', choices=['ledger', 'income', 'cc', 'wallet'])
        parser.add_argument('file', help='Path to the CSV file.')
        parser.add_argument('--ledger', choices=[c for c, _ in Ledger.choices],
                            help='Required for kind=ledger: saving, expense, ibadah or autodeduct.')
        parser.add_argument('--inbox', default='imported', help='Label for cc rows (default "imported").')
        parser.add_argument('--commit', action='store_true', help='Save the rows (otherwise dry run).')
        parser.add_argument('--replace', action='store_true',
                            help='Clear the same months first if they already hold rows (ledger and income).')

    def handle(self, *args, **options):
        path = Path(options['file'])
        if not path.is_file():
            raise CommandError(f'no such file: {path}')
        if options['kind'] == 'ledger' and not options['ledger']:
            raise CommandError('--ledger is required for kind=ledger')

        with path.open(encoding='utf-8-sig', newline='') as handle:
            try:
                if options['kind'] == 'ledger':
                    report = importers.read_ledger_csv(handle, options['ledger'])
                elif options['kind'] == 'income':
                    report = importers.read_income_csv(handle)
                elif options['kind'] == 'wallet':
                    report = importers.read_wallet_csv(handle)
                else:
                    report = importers.read_cc_csv(handle, inbox=options['inbox'])
            except ValueError as err:
                raise CommandError(str(err)) from None

        for line, message in report.errors[:50]:
            self.stderr.write(f'line {line}: ERROR {message}')
        for line, message in report.warnings[:50]:
            self.stdout.write(f'line {line}: warning {message}')
        if report.errors:
            raise CommandError(f'{len(report.errors)} bad row(s); nothing was written')

        if not options['commit']:
            if options['kind'] == 'cc':
                importers.drop_known_cc_duplicates(report)
            existing = importers.existing_rows_for(report)
            if report.rows and type(report.rows[0]).__name__ == 'WalletEntry':
                existing = WalletEntry.objects.all()
            if existing is not None and existing.exists():
                self.stdout.write(f'Note: {existing.count()} row(s) already exist for these months. '
                                  'A commit needs --replace.')
            self.stdout.write(f'DRY RUN. {report.summary()}')
            self.stdout.write('Run again with --commit to save.')
            return

        try:
            importers.save(report, replace=options['replace'])
        except ValueError as err:
            raise CommandError(str(err)) from None
        self.stdout.write(f'Saved. {report.summary()}')
