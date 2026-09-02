"""Puts the repo's shared python helpers on sys.path (#550).

scripts/sse_frame_conformance.py holds the wire-format conformance rules ONCE and
both backends drive them. It lives at the repo root rather than in either app for
the reason approval-frame-conformance.test.ts lives in test-utils: a copy beside
each plane could drift, and a drifted witness reports agreement it no longer
checks.

Explicit rather than relying on rootdir inference, so a run from the repo root
and a run from apps/fastapi-backend resolve identically.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))


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

from ai_backends import _common as _approval_common  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_approval_savers(monkeypatch):
    monkeypatch.setattr(_approval_common, "_SAVER_FACTORY", InMemorySaver)
    monkeypatch.setattr(_approval_common, "_SAVERS", {})
