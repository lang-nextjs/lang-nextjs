"""
Django settings for deepagents_backend project.
"""
import os
from urllib.parse import urlparse

# Load .env.local if present
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env.local'))
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Core settings
# ---------------------------------------------------------------------------

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'dev-insecure-key-do-not-use-in-prod')

DEBUG = True

ALLOWED_HOSTS = ['*']

# ---------------------------------------------------------------------------
# Application definition
# ---------------------------------------------------------------------------

INSTALLED_APPS = [
    'django.contrib.contenttypes',
    'django.contrib.auth',
    'corsheaders',
]

# CORS middleware must be first
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'deepagents_backend.urls'

ASGI_APPLICATION = 'deepagents_backend.asgi.application'

# ---------------------------------------------------------------------------
# Database — parse DATABASE_URL manually (no dj-database-url dep)
# ---------------------------------------------------------------------------

_db_url = os.environ.get('DATABASE_URL', 'postgres://postgres:postgres@db:5432/deepagents')
_parsed = urlparse(_db_url)

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': _parsed.path.lstrip('/'),
        'USER': _parsed.username or 'postgres',
        'PASSWORD': _parsed.password or 'postgres',
        'HOST': _parsed.hostname or 'db',
        'PORT': str(_parsed.port or 5432),
    }
}

# ---------------------------------------------------------------------------
# Cache — Redis
# ---------------------------------------------------------------------------

_redis_url = os.environ.get('REDIS_URL', 'redis://redis:6379/0')

CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.redis.RedisCache',
        'LOCATION': _redis_url,
    }
}

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

def _cors_allowed_origins() -> list[str]:
    """The CORS allowlist, from the environment, defaulting to the DEV origins.

    FOLLOWS THE `DJANGO_SECRET_KEY` PRECEDENT three files over: a dev default,
    an environment override, and a name that says which it is (#349). CORS was
    the one value in this repo with a dev default and NO override — and it is
    the one that silently keeps working in production when it is wrong, which
    is the opposite of the ordering you would choose.

    EMPTY MEANS EMPTY. `CORS_ALLOWED_ORIGINS=""` allows nothing; only an UNSET
    variable falls back to the dev list. An operator who deliberately empties an
    allowlist and silently gets the developer's laptop back would have no way to
    express what they meant.

    The default list is declared once in scripts/fixtures/cors-origins.json and
    scripts/check-cors-parity.mjs asserts all three backends still agree with
    it — before that file the copies had already drifted, with django missing
    http://localhost:3000 that the other two allowed.
    """
    raw = os.environ.get("CORS_ALLOWED_ORIGINS")
    if raw is None:
        return [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://frontend:3001",
            "http://frontend:3002",
        ]
    return [o.strip() for o in raw.split(",") if o.strip()]


CORS_ALLOWED_ORIGINS = _cors_allowed_origins()

CORS_ALLOW_METHODS = ['POST', 'OPTIONS']

CORS_ALLOW_HEADERS = ['Content-Type', 'Authorization']

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
