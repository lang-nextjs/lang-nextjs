"""The installed Langfuse SDK keeps the tracing path importable offline."""

import inspect
import subprocess
import sys

from langfuse import Langfuse
from langfuse.langchain import CallbackHandler


def test_callback_handler_constructs_without_credentials_or_network(monkeypatch):
    """Startup must not need a Langfuse server merely to load tracing support."""
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_HOST", raising=False)
    assert CallbackHandler() is not None


def test_callback_handler_still_consumes_our_metadata_keys():
    handler_module = inspect.getmodule(CallbackHandler)
    assert handler_module is not None
    source = inspect.getsource(handler_module)
    for key in ("langfuse_session_id", "langfuse_tags", "langfuse_user_id"):
        assert key in source


def test_status_probe_sdk_surface_still_exists():
    assert callable(Langfuse.auth_check)


def test_renamed_handler_import_is_rejected_control():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from langfuse.langchain import CallbackHandlerRenamedForContractControl",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "CallbackHandlerRenamedForContractControl" in result.stderr
