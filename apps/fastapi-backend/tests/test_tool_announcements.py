"""Every tool call is announced, not just the first.

Reported while asking to see tool inputs and outputs on the run page: a run
that called three tools showed one card with a name and two reading "tool".

The client received `tool-output-available` for calls it had never been told
about, because the ANNOUNCEMENT was dropped while the RESULT was emitted from
a different code path. Two independent drops did it:

  1. A tool with NO ARGUMENTS streams an empty args string, and empty was
     treated as unparseable — `increment` takes no parameters.

  2. The arg buffer is keyed by CHUNK INDEX, and index restarts across
     successive AI message chunks. `setdefault` merged a second tool call into
     the first call's buffer, and since `buf["id"]` is only overwritten when a
     chunk carries one, the second call kept the FIRST call's id. The dedupe
     then saw a familiar id and skipped it.

Measured before: 1 announcement for 3 calls. After: 3 for 3, twice running.

THE PYTHON PLANE HAS NO TEST RUNNER IN CI (#80), so these do not gate a merge.
They run with `pytest` inside the backend container. Said here rather than left
to be discovered — a test nothing executes looks like coverage.
"""

import json


def _drain(gen_frames):
    """Collect the emitted SSE payloads as dicts."""
    out = []
    for raw in gen_frames:
        for line in raw.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if not body or body == "[DONE]":
                continue
            try:
                out.append(json.loads(body))
            except json.JSONDecodeError:
                pass
    return out


def test_empty_args_is_a_call_not_a_drop():
    """A tool with no parameters has no argument text, and empty is not malformed."""
    from ai_backends import deepagents  # noqa: F401  (import must not explode)

    src = open(deepagents.__file__, encoding="utf8").read()
    # The guard that dropped it read `if not parsed: continue`.
    assert "if not parsed.strip():" in src
    assert "parsed = {}" in src


def test_a_new_id_at_a_reused_index_gets_a_fresh_buffer():
    """The dedupe must not see the previous call's id.

    Asserted structurally because reproducing it needs a provider that streams
    tool_call_chunks with repeating indices, which no unit test can conjure —
    and the alternative, asserting nothing, is what let it ship.
    """
    from ai_backends import deepagents

    src = open(deepagents.__file__, encoding="utf8").read()
    assert "tool_arg_buffers.get(key)" in src, "setdefault merges calls"
    assert 'buf["id"] != chunk_id' in src, "no reset on a changed id"


def test_unreadable_args_are_still_dropped():
    """Only genuinely malformed args are skipped.

    Inventing `{}` there would claim the model passed nothing when it may have
    passed something we failed to parse — a different lie from the one fixed.
    """
    from ai_backends import deepagents

    src = open(deepagents.__file__, encoding="utf8").read()
    assert "except json.JSONDecodeError:" in src
    # The continue must still be reachable from the decode failure.
    idx = src.index("except json.JSONDecodeError:")
    assert "continue" in src[idx : idx + 120]
