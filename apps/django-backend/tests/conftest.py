"""Minimal pytest harness for the django plane. There was none (#508).

apps/django-backend has had NO test files and no way to run one. That absence is
why scripts/check-run-axes-parity.mjs is a SOURCE check rather than a test — its
header says so outright: "The django backend has no test harness and `pnpm`
cannot see it — it has no package.json."

So this file is the harness, not a convenience. It does the two things Django
needs before any of its own machinery can be imported: name the settings module
and run django.setup(). Both must happen at COLLECTION time, before a test module
imports `deepagents_backend.views`, which is why they are at module scope here
rather than in a fixture.

NO DATABASE IS TOUCHED, and that is deliberate rather than incidental. settings
points DATABASES at postgres and CACHES at redis, neither of which exists in CI.
`django.setup()` does not connect — it only builds the app registry — and the
view under test reads neither. A test here that needed a database would need
pytest-django and a service container, and would be testing something else.
"""

import os
import sys
from pathlib import Path

# The backend package lives beside this tests/ directory. CI runs pytest with
# working-directory: apps/django-backend, but adding the path explicitly means a
# run from the repo root behaves identically rather than failing on import.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "deepagents_backend.settings")

import django  # noqa: E402  — must follow the env var above

django.setup()
