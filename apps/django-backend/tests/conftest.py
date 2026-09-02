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

# The repo's shared python helpers (#550). scripts/sse_frame_conformance.py holds
# the wire-format rules ONCE and both backends drive them; a copy beside each
# plane could drift, and a drifted witness reports agreement it no longer checks.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "deepagents_backend.settings")

import django  # noqa: E402  — must follow the env var above

django.setup()


# ---------------------------------------------------------------------------
# EVERY TEST GETS ITS OWN CHECKPOINTERS, THROUGH #643's INJECTION SEAM.
#
# The savers used to be six module constants and each fixture patched the one it
# needed. They are now resolved from `_common.approval_saver(__name__)`, so a
# test isolates itself by replacing the FACTORY and clearing the cache — which is
# the same mechanism a deployment uses to supply a durable saver. Per-test
# isolation and per-deployment choice are the same need, which is why one seam
# serves both and why this fixture is three lines rather than a mock.
#
# AUTOUSE, because the alternative is every approval test remembering. The old
# per-fixture patches were added one at a time as tests were written, and the
# `_graph` cache in this suite already demonstrated what a suite loses when
# isolation is opt-in: green or red by ORDER rather than by behaviour.
#
# ONE PER RUNG STILL, not one for the process. `derive_thread_id` puts no rung in
# the id, so rungs sharing a saver share a thread for the same session —
# measured: 2 messages leaked across rungs with one saver, 0 with separate ones.
# Clearing the cache preserves that; replacing it with a single instance would
# not.
# ---------------------------------------------------------------------------
import pytest  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from deepagents_backend.ai_backends import _common as _approval_common  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_approval_savers(monkeypatch):
    monkeypatch.setattr(_approval_common, "_SAVER_FACTORY", InMemorySaver)
    monkeypatch.setattr(_approval_common, "_SAVERS", {})
