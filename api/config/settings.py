"""Django settings. Every value that differs between local, dev and prod comes from the environment.

Cloud Run gets DATABASE_URL, DJANGO_SECRET_KEY and ALLOWED_EMAILS from Secret Manager and the
rest as plain environment variables. Nothing secret is ever written in this file.
"""

import os
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent

# local: a developer machine or docker compose. dev / prod: the Cloud Run services.
APP_ENV = os.environ.get('APP_ENV', 'local').strip().lower()
if APP_ENV not in {'local', 'dev', 'prod'}:
    raise ImproperlyConfigured(f'APP_ENV must be local, dev or prod, not {APP_ENV!r}')
IS_CLOUD = APP_ENV in {'dev', 'prod'}

DEBUG = os.environ.get('DJANGO_DEBUG', 'true' if APP_ENV == 'local' else 'false').lower() == 'true'
if IS_CLOUD and DEBUG:
    raise ImproperlyConfigured('DJANGO_DEBUG must be off on Cloud Run')

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', '')
if not SECRET_KEY:
    if IS_CLOUD:
        raise ImproperlyConfigured('DJANGO_SECRET_KEY is missing')
    SECRET_KEY = 'local-only-insecure-key'  # never used on Cloud Run (checked above)

ALLOWED_HOSTS = [h.strip() for h in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if h.strip()]
if not ALLOWED_HOSTS:
    ALLOWED_HOSTS = ['.run.app'] if IS_CLOUD else ['localhost', '127.0.0.1', 'api']

# The web addresses allowed to post the admin login form, e.g. https://<project>.web.app
CSRF_TRUSTED_ORIGINS = [o.strip() for o in os.environ.get('DJANGO_CSRF_TRUSTED_ORIGINS', '').split(',') if o.strip()]

# Sign-in: the Google OAuth web client ID (public) and the allowlist (secret on Cloud Run).
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '').strip()
ALLOWED_EMAILS = frozenset(
    e.strip().lower() for e in os.environ.get('ALLOWED_EMAILS', '').split(',') if e.strip()
)
if IS_CLOUD and (not GOOGLE_CLIENT_ID or not ALLOWED_EMAILS):
    raise ImproperlyConfigured('GOOGLE_CLIENT_ID and ALLOWED_EMAILS are required on Cloud Run')

# The commit the image was built from, shown by /api/health.
APP_VERSION = os.environ.get('APP_VERSION', 'local')

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'core',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'core.middleware.RequestLogMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

# Postgres everywhere it matters (docker compose, Neon). A bare `manage.py` run without
# DATABASE_URL falls back to SQLite so quick checks work without a database server.
DATABASE_URL = os.environ.get('DATABASE_URL', '')
if not DATABASE_URL and IS_CLOUD:
    raise ImproperlyConfigured('DATABASE_URL is missing')
DATABASES = {
    'default': dj_database_url.parse(
        DATABASE_URL or f'sqlite:///{BASE_DIR / "local.sqlite3"}',
        conn_max_age=60,
        conn_health_checks=True,
    )
}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Shared cache for verified sign-ins and the failure throttle. Per instance is enough:
# Cloud Run runs at most two instances and a miss only costs one Google certificate check.
CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Asia/Jakarta'  # must match the ledgers: month keys are Jakarta months
USE_I18N = False
USE_TZ = True

# Served by WhiteNoise under /api/static/ so Firebase's /api/** rewrite reaches them.
STATIC_URL = '/api/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'},
}

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ['core.auth.GoogleIdTokenAuthentication'],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
    'DEFAULT_PARSER_CLASSES': ['rest_framework.parsers.JSONParser'],
    'UNAUTHENTICATED_USER': None,
    'EXCEPTION_HANDLER': 'core.errors.api_exception_handler',
}

# Behind Cloud Run's front end every request arrives over HTTPS.
if IS_CLOUD:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_CONTENT_TYPE_NOSNIFF = True

# One line per record on stdout; Cloud Logging picks it up as-is.
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'line': {'format': '%(levelname)s %(name)s %(message)s'},
    },
    'handlers': {
        'stdout': {'class': 'logging.StreamHandler', 'formatter': 'line'},
    },
    'root': {'handlers': ['stdout'], 'level': 'INFO'},
    'loggers': {
        'fintrack': {'level': os.environ.get('LOG_LEVEL', 'DEBUG' if DEBUG else 'INFO'), 'propagate': True},
        'django.request': {'level': 'ERROR', 'propagate': True},  # 4xx are already in fintrack.request
    },
}
