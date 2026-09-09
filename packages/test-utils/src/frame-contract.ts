/**
 * THE WIRE CONTRACT AS A READER, WITH A MESSAGE THAT NAMES WHAT IS WRONG (#939).
 *
 * `approval-frame-conformance.test.ts` used to validate emitted frames with the SDK's own
 * `uiMessageChunkSchema`, resolved out of the installed `ai`. That was the right instrument while
 * the SDK was strict. Under `ai` v7 it is not: the chunk union moved from `strictObject` to
 * `looseObject`, and both of that file's POSITIVE CONTROLS went red — the arms asserting that a
 * known-bad frame is REJECTED. Measured on `ai@7.0.93`:
 *
 *     ACCEPT  { type: "tool-input-start", toolCallId, toolName, input }   <- ai@6 rejects this
 *     ACCEPT  { type: "finish", finishReason, totalUsage }                <- ai@6 rejects this
 *
 * A suite whose positive controls had gone GREEN through that bump would have been the worrying
 * outcome. The reds are the controls working, and what they report is that the vendor's
 * strictness — never the property under test, only the mechanism that happened to supply it —
 * is gone.
 *
 * SO THE READER IS OURS. `docs/sse-frame-schema.json` carries `additionalProperties: false` on
 * all 21 variants since #945, which is the same property, asserted by this repository about its
 * own contract rather than borrowed from a dependency. It cannot be taken away by a bump.
 *
 * WHAT THIS DELIBERATELY IS NOT USED FOR. `finish-frame-conformance.test.ts` builds MAXIMAL
 * INSTANCES OUT OF THE CONTRACT and asks whether an independent reader accepts them. Pointing
 * that file here would compare the document with itself: measured, 18 of its 21 instances are
 * accepted trivially and the other 3 fail on a limitation of the instance builder rather than on
 * anything about the wire. Its independence has to come from somewhere else.
 */
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

/*
 * `import.meta.url` RATHER THAN `__dirname` (#1000), which is CommonJS-only. This package
 * declares `"type": "commonjs"` today so both spellings work — but ESM-only packaging is already
 * live on this board (`@ai-sdk/react` 4.x), and a toolchain default can move underneath a package
 * without anyone choosing it. Then this fails at RUNTIME rather than at build.
 *
 * BOTH SITES CHANGED TOGETHER, DELIBERATELY. Converting one would typecheck, pass, and leave the
 * pair inconsistent — a repair that LOOKS complete is worse than an untouched one, because it
 * removes the reason anyone would look again. `sdk-declared-chunks.ts` already took the modern
 * form and said so in a comment naming this issue, so this leaves the package with one spelling.
 *
 * THE PATH IS STILL REPO-ROOT-RELATIVE AND THAT EXPOSURE IS UNCHANGED. Reading
 * `docs/sse-frame-schema.json` asserts that file's existence and location, and this repository is
 * severable — an ejected tree may not have it. #1000 records that deliberately as NOT resolved
 * here: importing the JSON instead needs `resolveJsonModule` and a path outside `rootDir`, which
 * reproduces the TS6059 that `tsconfig.parity.json` exists to route around. It moves the problem
 * rather than removing it.
 */
const schemaPath = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../../docs/sse-frame-schema.json"
);

type Fragment = { properties?: Record<string, unknown> };

/**
 * A missing or one-branch contract must not read as a clean run — the same two guards
 * `scripts/sse_frame_conformance.py` makes, for the same reason: a validator built from a
 * contract nobody could read reports conformance vacuously.
 */
if (!fs.existsSync(schemaPath)) {
  throw new Error(
    `contract not found at ${schemaPath} — this reader cannot report a verdict`
  );
}
const contract = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
  oneOf: Fragment[];
};
if (!Array.isArray(contract.oneOf) || contract.oneOf.length < 2) {
  throw new Error(
    `the contract declares ${
      contract.oneOf?.length ?? 0
    } frame kind(s). A one-branch oneOf accepts too much for conformance to mean anything.`
  );
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(contract);

/**
 * The property names the contract declares for one frame kind, or `null` when no branch claims
 * that `type`.
 *
 * NULL RATHER THAN AN EMPTY SET, which is `sse_frame_conformance.py`'s distinction and worth
 * keeping identical: a caller must be able to tell "declares nothing" from "is not declared at
 * all". An undeclared kind is already reported by the validator, and listing every one of its
 * keys as undeclared on top of that buries the real line.
 */
export function declaredProperties(frameType: unknown): Set<string> | null {
  for (const branch of contract.oneOf) {
    const props = (branch.properties ?? {}) as Record<
      string,
      { const?: unknown }
    >;
    if (props.type?.const === frameType) return new Set(Object.keys(props));
  }
  return null;
}

export type ContractVerdict = {
  valid: boolean;
  /** Keys the frame carries that its own variant does not declare; `null` if the kind is not declared. */
  undeclared: string[] | null;
  /** The sentence a reader gets. Empty when valid. */
  message: string;
};

/**
 * Does the contract accept this frame, and if not, WHICH KEY made it fail?
 *
 * THE VERDICT COMES FROM THE UNION AND THE DIAGNOSIS FROM THE BRANCH, because neither can do
 * both. Ajv validates the whole 21-branch `oneOf` and does not use the discriminator, so a
 * rejection produces 94 errors and the FIRST one names `toolCallId` from an unrelated branch —
 * a true failure attributed to the wrong field. `sse_frame_conformance.py` hit this and says
 * why: "a failure under `oneOf` cannot attribute itself to a branch". So the branch is selected
 * here by `properties.type.const`, exactly as that file does, and the undeclared keys are
 * computed against it.
 */
export function checkFrame(frame: unknown): ContractVerdict {
  const valid = validate(frame) as boolean;
  const type =
    frame && typeof frame === "object"
      ? (frame as Record<string, unknown>).type
      : undefined;
  const declared = declaredProperties(type);

  if (declared === null) {
    return {
      valid,
      undeclared: null,
      message: valid
        ? ""
        : `the contract declares no frame of type ${JSON.stringify(type)}`,
    };
  }

  const undeclared = Object.keys(
    (frame ?? {}) as Record<string, unknown>
  ).filter((k) => !declared.has(k));

  if (valid) return { valid, undeclared, message: "" };

  return {
    valid,
    undeclared,
    message: describe(type, undeclared, missingIn(frame, type)),
  };
}

/**
 * The declared-but-absent keys, one level into `data` as well as at the top.
 *
 * ADDED ON THE FIRST REAL USE, WHICH IS WHERE THIS DESIGN COULD FIRST BE WRONG. Re-pointing the
 * approval suite here immediately produced a rejection that was NOT an undeclared key, and the
 * fallback printed three ajv lines from unrelated branches — the exact failure this file exists
 * to avoid, one case over. `data-approval-required` declares `data.required` of
 * [id, toolCallId, toolName, input] and the server emits none of the last three, so the frame
 * fails on REQUIRED, not on extra keys.
 *
 * AND `data` IS WHERE THIS HAS TO LOOK. `additionalProperties: false` binds a frame's OWN keys —
 * the siblings of `type` — and does not reach inside `data`; `sse_frame_conformance.py` records
 * the same boundary. A message that only ever inspects the top level is therefore silent about
 * every `data-*` divergence, which is most of them.
 */
function missingIn(frame: unknown, frameType: unknown): string[] {
  for (const branch of contract.oneOf) {
    const props = (branch.properties ?? {}) as Record<string, any>;
    if (props.type?.const !== frameType) continue;
    const out: string[] = [];
    for (const req of (branch as any).required ?? [])
      if (!(req in ((frame ?? {}) as Record<string, unknown>))) out.push(req);
    const payload = ((frame ?? {}) as Record<string, unknown>).data;
    for (const req of props.data?.required ?? [])
      if (!payload || !(req in (payload as Record<string, unknown>)))
        out.push(`data.${req}`);
    return out.sort();
  }
  return [];
}

function describe(
  type: unknown,
  undeclared: string[],
  missing: string[]
): string {
  const parts: string[] = [];
  if (undeclared.length)
    parts.push(
      `carries ${JSON.stringify(
        undeclared.slice().sort()
      )}, which the contract does not declare`
    );
  if (missing.length)
    parts.push(
      `is missing ${JSON.stringify(missing)}, which the contract requires`
    );
  if (parts.length === 0)
    parts.push(
      `was rejected for a reason the branch comparison cannot name; ajv's own errors span all ` +
        `${contract.oneOf.length} branches and attribute to none`
    );
  return `a ${String(type)} frame ${parts.join(", and ")}.`;
}
