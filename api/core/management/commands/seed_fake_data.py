from datetime import date

from django.core.management.base import BaseCommand, CommandError

from core import fakedata


class Command(BaseCommand):
    help = 'Adds obviously fake sample data for dev and local testing. Refused in prod.'

    def add_arguments(self, parser):
        parser.add_argument('--months', type=int, default=3, help='How many months to create (default 3).')
        parser.add_argument('--end', default=None, help='Last month, YYYY-MM (default: this month).')
        parser.add_argument('--seed', type=int, default=1, help='Random seed, so runs repeat (default 1).')

    def handle(self, *args, **options):
        if options['months'] < 1 or options['months'] > 24:
            raise CommandError('--months must be between 1 and 24')
        try:
            end = date.fromisoformat(f"{options['end']}-01") if options['end'] else date.today().replace(day=1)
        except ValueError:
            raise CommandError('--end must look like YYYY-MM') from None
        try:
            created = fakedata.seed(options['months'], end, options['seed'])
        except RuntimeError as err:
            raise CommandError(str(err)) from None
        self.stdout.write(
            f"Created sample rows: ledger={created['ledger']} income={created['income']} cc={created['cc']}"
        )
