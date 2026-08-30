"""The CORS allowlist is configurable, and empty means empty (#349).

All three backends hardcoded the dev origins with no environment override.
That made it the one value in this repo with a dev default and NO way to
change it — and the one that silently keeps working in production when it is
wrong. django's `SECRET_KEY` three files from its own CORS list is the pattern
it was missing: a dev default, an environment override, and a name that says
which it is.

THE CASES COME FROM scripts/fixtures/cors-origins.json, not from this file.
Three backends implement one contract in two languages; a table restated per
backend is three sources of truth that agree until they do not. The fixture is
the declaration, this asserts fastapi against it, node's server.test.ts asserts
the same table, and scripts/check-cors-parity.mjs asserts all three still read
the same variable and default to the same list.

WHAT THIS CANNOT COVER: django has no test harness and no package.json, so its
half of the contract is asserted at the source level by that script rather than
by a request. Named here so the absence is a known bound rather than an
oversight.
"""

import importlib
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / "scripts/fixtures/cors-origins.json").read_text())
ENV_VAR = FIXTURE["envVar"]
DEV_DEFAULT = FIXTURE["devDefault"]

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _origins(monkeypatch, value):
    """Re-read the allowlist with the environment set to `value`."""
    if value is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, value)
    import main

    importlib.reload(main)
    return main._cors_allowed_origins()


def test_fixture_has_cases():
    """A table-driven test over an empty table passes while asserting nothing."""
    assert len(FIXTURE["parseCases"]) > 3
    assert len(DEV_DEFAULT) > 0


@pytest.mark.parametrize("case", FIXTURE["parseCases"], ids=lambda c: c["why"][:40])
def test_parse_cases(monkeypatch, case):
    expected = DEV_DEFAULT if case["expect"] == "DEV_DEFAULT" else case["expect"]
    assert sorted(_origins(monkeypatch, case["input"])) == sorted(expected)


def test_the_environment_REPLACES_the_default_rather_than_extending_it(monkeypatch):
    """Both halves, because one alone is satisfied by a merge.

    An implementation that merged the configured origins into the dev list
    would pass "the configured origin is allowed" and would mean an operator
    can never actually remove localhost. So the second assertion is the one
    that carries the requirement.
    """
    got = _origins(monkeypatch, "https://app.example")
    assert "https://app.example" in got
    assert DEV_DEFAULT[0] not in got, (
        f"{DEV_DEFAULT[0]} survived an environment that did not list it — "
        "the default is being merged in, so it cannot be removed"
    )


def test_unset_falls_back_to_the_dev_default(monkeypatch):
    """The fallback is what keeps local work unchanged; it is not decoration."""
    assert sorted(_origins(monkeypatch, None)) == sorted(DEV_DEFAULT)


def test_the_app_actually_uses_it(monkeypatch):
    """WIRING, NOT JUST PARSING.

    Every case above tests the function. A backend that parsed correctly and
    then passed a hardcoded list to CORSMiddleware would satisfy all of them —
    which is exactly the state this issue is about, one level in.
    """
    monkeypatch.setenv(ENV_VAR, "https://only-this.example")
    import main

    importlib.reload(main)
    configured = [
        m for m in main.app.user_middleware if "CORSMiddleware" in str(m)
    ]
    assert configured, "no CORSMiddleware is installed"
    assert "https://only-this.example" in str(configured[0])
    assert DEV_DEFAULT[0] not in str(configured[0])
