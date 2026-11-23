from django.core.management.base import BaseCommand

from core import backup


class Command(BaseCommand):
    help = 'Writes one backup of every table to the backup bucket (or BACKUP_DIR locally).'

    def handle(self, *args, **options):
        self.stdout.write(f'Backup written to {backup.run_backup()}')
