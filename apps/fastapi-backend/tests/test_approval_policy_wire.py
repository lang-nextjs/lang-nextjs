"""The policy crosses the wire, an absent one is refused, and the inversion fails closed.

THE REFUSAL NEEDS A PRESENCE COMPANION, exactly as the withholding did. "It refuses on an
absent field" is satisfied by something that refuses everything, so every rejection case here
is paired with a well-formed request that must still succeed. That pairing is the whole
reason these are in one file rather than a list of negative assertions.
"""

import pytest

from ai_backends._common import (
    ALLOWLIST_KEY,
    FIELD,
    ApprovalPolicyError,
    interrupt_on_for,
    parse_approval_policy,
)

WELL_FORMED = {FIELD: {ALLOWLIST_KEY: ["read_file", "ls", "get_counter"]}}


# --------------------------------------------------------------------------- refusals


def test_an_absent_policy_is_refused():
    """THE CONSTRAINT. Not "gate nothing", not "gate everything" — refuse.

    A gate built from an absent policy reports having considered a question it never
    considered. #368's `asPythonBackend` coercion is the same defect one subject over: an
    unknown value handled by defaulting rather than failing.
    """
    with pytest.raises(ApprovalPolicyError) as excinfo:
        parse_approval_policy({"messages": [], "topology": "react"})
    # The message must say what to send. A refusal that only says "invalid" moves the work
    # of guessing the contract onto whoever hits it.
    assert ALLOWLIST_KEY in str(excinfo.value)


def test_a_policy_that_is_not_an_object_is_refused():
    with pytest.raises(ApprovalPolicyError):
        parse_approval_policy({FIELD: ["read_file"]})


def test_a_policy_with_no_allowlist_is_refused():
    """"Missing" and "empty" are different answers and must not share a code path."""
    with pytest.raises(ApprovalPolicyError):
        parse_approval_policy({FIELD: {}})


def test_an_allowlist_that_is_a_bare_string_is_refused():
    """A string is iterable, so a laxer check would read "ls" as ["l", "s"].

    That allowlist matches no tool name, so every tool would be gated — the SAFE direction,
    which is precisely why it would survive review while meaning nothing the sender intended.
    """
    with pytest.raises(ApprovalPolicyError):
        parse_approval_policy({FIELD: {ALLOWLIST_KEY: "read_file"}})


def test_a_non_string_entry_is_refused():
    with pytest.raises(ApprovalPolicyError):
        parse_approval_policy({FIELD: {ALLOWLIST_KEY: ["read_file", 7]}})


# --------------------------------------------------------------------------- the companions


def test_a_well_formed_policy_is_accepted():
    """THE PRESENCE COMPANION for every rejection above.

    Without this, a parser that raised unconditionally would pass all five.
    """
    assert parse_approval_policy(WELL_FORMED) == frozenset(
        {"read_file", "ls", "get_counter"}
    )


def test_an_explicitly_empty_allowlist_is_accepted_and_gates_everything():
    """`[]` is a statement, not an absence — and it is the STRICTEST configuration.

    Conflating it with a missing field would make the safest possible request
    indistinguishable from a malformed one.
    """
    allowlist = parse_approval_policy({FIELD: {ALLOWLIST_KEY: []}})
    assert allowlist == frozenset()
    assert interrupt_on_for(allowlist, ["read_file", "increment"]) == {
        "read_file": True,
        "increment": True,
    }


# --------------------------------------------------------------------------- the inversion


def test_the_allowlist_excuses_only_what_it_names():
    allowlist = parse_approval_policy(WELL_FORMED)
    gated = interrupt_on_for(allowlist, ["read_file", "ls", "increment", "write_file"])
    assert gated == {"increment": True, "write_file": True}


def test_a_tool_the_sender_never_heard_of_is_GATED():
    """THE FAIL-CLOSED PROPERTY, and the reason the wire carries an allowlist.

    This is the case that would have been inverted by sending the gated names instead. A
    gated-name list enumerates what the sender knows about, so `mcp__unknown__delete_repo` —
    a tool this backend has and open-swe has never seen — would arrive ungated. The
    allowlist form cannot express that mistake: anything the sender did not excuse is gated,
    whether or not the sender knew it existed.
    """
    allowlist = parse_approval_policy(WELL_FORMED)
    gated = interrupt_on_for(allowlist, ["mcp__unknown__delete_repo"])
    assert gated == {"mcp__unknown__delete_repo": True}


def test_an_empty_inventory_gates_nothing_rather_than_erroring():
    """A backend with no tools has nothing to gate, and that is not a failure.

    Stated because "gates nothing" is otherwise the shape this file spends its length warning
    about — here it is correct, and the reason is that the INVENTORY is empty rather than the
    policy being absent.
    """
    assert interrupt_on_for(parse_approval_policy(WELL_FORMED), []) == {}
