"""The model sees the conversation, not just the last thing said (#643).

THE BUG. Both dispatches built the model input from `messages[-1]` alone, so an
UNGATED topology saw one message per request and could not refer to anything
said earlier. The client had been sending the whole conversation the entire
time; we dropped it.

WHY THE UNGATED CASE IS THE ONE THAT MATTERS, and why a gated-only test would
have proved nothing: gated topologies get a thread_id and a checkpointer, so
LangGraph REPLAYS prior turns. Multi-turn appears to work there whether or not
this fix exists — the same assertion is green before and after. It is the
default, ungated configuration that was broken, which is why the bug survived:
it is invisible in exactly the setup people demo.

ON "A TEST THAT FAILS ON MAIN": this exercises a function main does not have, so
it cannot be run against main literally. What it does instead is pin BOTH
branches — the gated branch reproduces main's behaviour exactly, so restoring
main's behaviour in the ungated branch (returning only the last turn) fails
`test_an_ungated_turn_carries_the_whole_conversation` the two tests that assert the ungated path, and leaves the gated and empty
cases green. That mutation was run: 2 passed, 2 failed, identically on both
planes. (This first claimed "and nothing else"; the measurement said two, so
the sentence changed rather than the count.)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_backends._common import model_input_messages  # noqa: E402

DISPATCH = Path(__file__).resolve().parents[1] / "main.py"
BACKEND_SOURCES = sorted(
    (Path(__file__).resolve().parents[1] / "ai_backends").glob("[!_]*.py")
)

CONVERSATION = [
    {"role": "user", "content": "FIRST TURN"},
    {"role": "assistant", "content": "a reply"},
    {"role": "user", "content": "SECOND TURN"},
]


def test_an_ungated_turn_carries_the_whole_conversation():
    """THE REGRESSION. No thread, no replay — so the history comes from us."""
    got = model_input_messages(CONVERSATION, gated=False)
    assert len(got) == 3, got
    assert any("FIRST TURN" in m["content"] for m in got), (
        "the second turn's model input does not contain the first turn — the "
        "model cannot refer to anything the user said before"
    )
    assert [m["role"] for m in got] == ["user", "assistant", "user"], got


def test_a_gated_turn_sends_only_the_new_message():
    """THE OTHER DIRECTION, and it is not a formality.

    Gated topologies have a checkpointer holding the thread. Sending the history
    as well would stack our payload on the replay and double-count every turn,
    which is worse than the bug being fixed. This pins that we do NOT.
    """
    got = model_input_messages(CONVERSATION, gated=True)
    assert got == [{"role": "user", "content": "SECOND TURN"}], got


def test_no_messages_is_one_empty_user_turn_on_both_paths():
    """Unchanged from before the fix, deliberately: the empty case was not broken."""
    assert model_input_messages([], gated=False) == [{"role": "user", "content": ""}]
    assert model_input_messages([], gated=True) == [{"role": "user", "content": ""}]


def test_contentless_messages_are_dropped_rather_than_sent_empty():
    """An assistant turn that carried only a tool call has no text to replay, and
    an empty content string is not the same fact as an absent turn."""
    got = model_input_messages(
        [
            {"role": "user", "content": "FIRST TURN"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "SECOND TURN"},
        ],
        gated=False,
    )
    assert [m["content"] for m in got] == ["FIRST TURN", "SECOND TURN"], got

def test_the_gated_branch_still_passes_a_thread_config():
    """THE PREMISE UNDERNEATH `test_a_gated_turn_sends_only_the_new_message`.

    That test asserts we do NOT re-send the history when gated, and it is only
    correct because something else replays it. The day a topology stops calling
    `set_thread_id`, that assertion keeps passing FOR THE WRONG REASON — nothing
    is replayed and nothing is sent, so the model silently sees one message
    again and the suite stays green. An absence assertion whose subject expired.

    So the premise is asserted rather than assumed: the dispatch's gated branch
    must still record a thread. Nothing else in the repo checks this — the
    parity gate's "both dispatches record a session" is about `set_run_axes`
    tagging, not about the checkpointer thread.
    """
    src = DISPATCH.read_text()
    assert "if gated:" in src, f"{DISPATCH} no longer has a gated branch to check"
    after = src.split("if gated:", 1)[1].split("\n")[1:]
    indent = None
    block = []
    for line in after:
        if not line.strip():
            block.append(line)
            continue
        width = len(line) - len(line.lstrip())
        if indent is None:
            indent = width
        if width < indent:
            break
        block.append(line)
    body = "\n".join(block)
    assert "set_thread_id" in body, (
        "the gated branch no longer calls set_thread_id, so gated topologies get "
        "no checkpointer thread — and the 'we do not re-send the history' "
        "assertion above would now pass for the wrong reason, with the model "
        "seeing one message per turn again"
    )


def test_something_is_actually_gated():
    """And that the gated path is reachable at all.

    If every GATED_TOPOLOGIES went empty, both tests above would still pass
    while the branch they describe was dead. Reads the backends rather than
    naming a topology, so it survives the set changing -- which it has: langgraph
    and deepagents both gained `react` while this issue was open.
    """
    gated = {}
    for mod in BACKEND_SOURCES:
        text = mod.read_text()
        for line in text.splitlines():
            if line.startswith("GATED_TOPOLOGIES"):
                gated[mod.stem] = line
    assert gated, "no backend declares GATED_TOPOLOGIES at all"
    assert any("frozenset({" in v for v in gated.values()), (
        f"every backend now gates nothing ({gated}), so the gated branch is dead "
        f"code and the assertions about it describe nothing"
    )
