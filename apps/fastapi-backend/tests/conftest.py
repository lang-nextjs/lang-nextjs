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
