"""ONE DEFINITION OF "CONFORMS", DRIVEN BY BOTH PYTHON PLANES (#550).

docs/sse-frame-schema.json has existed and been Ajv-validated since #59, and
every consumer of it was TypeScript: packages/server/src/sse-frame-schema.test.ts
validates TypeScript-produced frames, packages/react and scripts/ read it, and NO
PYTHON RESPONSE HAS EVER BEEN VALIDATED AGAINST IT. That is why E2E-02's parity
half stayed open — not a missing test, a reference nobody pointed at the other
language plane.

WHY THIS FILE IS SHARED RATHER THAN COPIED INTO EACH BACKEND. The precedent is
packages/test-utils/src/approval-frame-conformance.test.ts: one suite driving
both real implementations. A COPIED FIXTURE CANNOT BE ITS OWN WITNESS — two
copies drifting is the failure mode check-run-axes-parity.mjs exists for, and
writing the conformance rules twice would reintroduce it inside the check meant
to close it. The two backends import this; only the DRIVING differs, because
each must produce its own real response.

WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves each plane's frames conform to
a DECLARATION. It does not prove the declaration matches what any client
actually accepts, and it cannot detect both planes being wrong in the same way if
the schema is wrong too — the schema is the only reference here. #527 compares
the two implementations to each other and has the mirror-image limitation; the
two together are stronger than either, and neither is proof of correctness.

MEASURED BEFORE RELYING ON IT, because a schema loose enough to accept anything
would make every assertion below vacuous. Against the real file: a text-delta
missing `delta` is rejected, a `delta` of the wrong type is rejected, an unknown
frame type is rejected, and a frame with no `type` is rejected.

AN EXTRA KEY IS A DEFECT, NOT A DETAIL (#714). This module used to say, in this
docstring, that it "DOES permit unknown extra properties — there is no
`additionalProperties: false` — so this checks that every frame is a well-formed
member of a known kind, not that it carries nothing else." That sentence named
the hole a defect then walked through it: a python plane added `totalUsage` to
its `finish` frame, every assertion here stayed green, and the client threw the
whole turn away. AI SDK v6 builds its UI-message chunk union out of
`z.strictObject()`, so on the wire an UNDECLARED key is not ignored — it rejects
the frame. `undeclared_property_failures` below asks that question, and
packages/test-utils/src/finish-frame-conformance.test.ts asks the one this file
still cannot: whether the declaration itself is one the SDK accepts.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "docs" / "sse-frame-schema.json"


def load_schema() -> dict:
    """The parsed contract, or a hard failure. An unreadable schema is not
    'nothing to check' — every conformance assertion downstream would pass
    vacuously."""
    if not SCHEMA_PATH.exists():
        raise AssertionError(
            f"{SCHEMA_PATH} does not exist. Refusing to report conformance "
            f"against a schema that could not be read."
        )
    schema = json.loads(SCHEMA_PATH.read_text())
    branches = schema.get("oneOf") or []
    if len(branches) < 2:
        raise AssertionError(
            f"the schema declares {len(branches)} frame kind(s). A one-branch "
            f"oneOf accepts too much for conformance to mean anything."
        )
    return schema


def load_validator():
    """The validator, built from the same guarded read as everything else."""
    from jsonschema import Draft202012Validator

    return Draft202012Validator(load_schema())


def declared_properties(schema: dict, frame_type) -> set | None:
    """The property names the contract declares for one frame kind.

    `None` — rather than an empty set — when no branch claims this `type`, so a
    caller can tell "declares nothing" from "is not declared at all". An
    undeclared kind is already reported by the validator; reporting every one of
    its keys as undeclared on top of that would bury the real line.
    """
    for branch in schema.get("oneOf") or []:
        props = branch.get("properties") or {}
        if (props.get("type") or {}).get("const") == frame_type:
            return set(props)
    return None


def undeclared_property_failures(frames: list[dict]) -> list[str]:
    """Keys the contract does not declare, which the CLIENT will not tolerate.

    Separate from the jsonschema pass because the two ask different questions
    and the schema can only ask one of them: `additionalProperties: false` on
    every branch would make the contract unusable as documentation, since it is
    also read by consumers who legitimately extend `data-*` payloads. This asks
    the strict question directly, and only of frame kinds the contract claims.
    """
    schema = load_schema()
    failures = []
    for i, frame in enumerate(frames):
        declared = declared_properties(schema, frame.get("type"))
        if declared is None:
            continue
        undeclared = sorted(set(frame) - declared)
        if undeclared:
            failures.append(
                f"frame {i} ({frame.get('type')!r}) carries {undeclared}, which "
                f"the contract does not declare. AI SDK v6 parses this frame "
                f"with z.strictObject(): an undeclared key does not degrade the "
                f"frame, it REJECTS it."
            )
    return failures


def parse_frames(body: str) -> list[dict]:
    """Every `data:` payload in an SSE body, JSON-decoded.

    `[DONE]` is the AI SDK's terminator sentinel and not a frame; `:` lines are
    SSE keepalive comments. Both are skipped rather than failed, per the spec.
    """
    frames: list[dict] = []
    for line in body.split("\n"):
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        frames.append(json.loads(payload))
    return frames


def conformance_failures(frames: list[dict]) -> list[str]:
    """Every way this frame sequence fails the wire format, as readable lines.

    A list rather than a bool so a failure names the frame and the reason; a
    caller asserting `== []` gets the whole story in the diff.
    """
    if not frames:
        return [
            "the body carried ZERO frames. An empty sequence conforms to "
            "anything, so this is a broken probe rather than a clean stream."
        ]

    validator = load_validator()
    failures = []
    for i, frame in enumerate(frames):
        for err in sorted(validator.iter_errors(frame), key=str):
            failures.append(
                f"frame {i} ({frame.get('type', '<no type>')!r}) violates the "
                f"schema: {err.message}"
            )

    failures.extend(undeclared_property_failures(frames))

    # TERMINATION IS PART OF THE WIRE FORMAT, not an extra. A stream that ends
    # without a terminal frame is indistinguishable at the proxy from a
    # mid-stream disconnect — which is #247's whole subject, on both planes.
    if frames[-1].get("type") != "finish":
        failures.append(
            f"the sequence ends with {frames[-1].get('type')!r}, not 'finish'. "
            f"A stream with no terminal frame reads to the proxy as a dropped "
            f"connection."
        )
    return failures
