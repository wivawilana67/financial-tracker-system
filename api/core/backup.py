"""Nightly backup: every table as a Django fixture (JSON, gzipped). Restore with `manage.py loaddata`.

Written to BACKUP_BUCKET (Cloud Storage, private) on Cloud Run, or to BACKUP_DIR when no bucket is set.
A logical dump instead of pg_dump, so the job does not depend on a Postgres client version matching Neon.
"""

import gzip
import logging
from datetime import datetime, timezone
from pathlib import Path

import requests
from django.apps import apps
from django.conf import settings
from django.core import serializers

from . import gmail_auth

log = logging.getLogger('fintrack.backup')
MODELS = ('core.LedgerEntry', 'core.IncomeEntry', 'core.CcTransaction', 'core.WalletEntry',
          'core.SyncRun', 'core.ParseFailure', 'core.MonthlyDraft')
UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=media&name={name}'


def dump_bytes() -> bytes:
    chunks = ['[']
    first = True
    for label in MODELS:
        model = apps.get_model(label)
        body = serializers.serialize('json', model.objects.all().order_by('pk'))
        inner = body.strip()[1:-1].strip()
        if inner:
            chunks.append(('' if first else ',') + inner)
            first = False
    chunks.append(']')
    return gzip.compress(''.join(chunks).encode('utf-8'))


def run_backup() -> str:
    """Writes one backup. Returns where it went (a bucket object name or a file path)."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = f'fintrack-{stamp}.json.gz'
    data = dump_bytes()
    if settings.BACKUP_BUCKET:
        token = gmail_auth._cloud_token()  # this service's own identity
        res = requests.post(UPLOAD.format(bucket=settings.BACKUP_BUCKET, name=name),
                            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/gzip'},
                            data=data, timeout=120)
        res.raise_for_status()
        log.info('backup written to bucket bytes=%s', len(data))
        return f'gs://{settings.BACKUP_BUCKET}/{name}'
    folder = Path(settings.BACKUP_DIR)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_bytes(data)
    log.info('backup written to disk bytes=%s', len(data))
    return str(path)
