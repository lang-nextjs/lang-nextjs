/**
 * WHAT THE SDK DECLARES, READ FROM ITS DECLARATIONS RATHER THAN FROM ITS VALIDATOR (#714, #972).
 *
 * `finish-frame-conformance.test.ts` asks whether every frame `docs/sse-frame-schema.json`
 * declares is one the client accepts. Its instrument was `uiMessageChunkSchema` — the SDK's
 * RUNTIME validator — which answered that question while the chunk union was built from
 * `z.strictObject()`. Under `ai` v7 it is `looseObject`, and it stops answering. Measured, both
 * versions installed side by side:
 *
 *     ai@6.0.197   REJECT   { type: "finish", finishReason: "stop", totalUsage: {...} }
 *     ai@7.0.93    ACCEPT   the same frame
 *
 * THE DEFECT DID NOT GO AWAY, IT WENT QUIET, and that is the whole reason this file exists
 * rather than a deletion. `totalUsage` is a field of the SDK's onFinish/StepResult CALLBACK
 * shape, not of the wire chunk — the name collision is what #714 was about. Under v6 the client
 * refused the terminal frame and discarded the turn, loudly. Under v7 it accepts the frame and
 * silently drops the usage: the turn renders, the number is missing, and nothing anywhere
 * reports a problem. Restoring only a red control would leave that unsaid.
 *
 * AND THE 21 ACCEPTANCE ASSERTIONS WENT VACUOUS AT THE SAME TIME, which is the larger half. A
 * loose reader accepts a maximal instance of anything, so all 21 passed while checking nothing;
 * measured on v7, the suite reported `1 failed | 23 passed` and the 23 included every one of
 * them. The target is discrimination for 22 assertions, not for the control alone.
 *
 * SO THE READER IS THE SDK'S DECLARATIONS. Every route to a strict runtime artifact is closed
 * under v7, and that was measured rather than assumed:
 *
 *     validate      closes over a module-private `zodSchema2` — not reachable from outside
 *     _type         `undefined` at runtime; it is a phantom type marker
 *     jsonSchema    a getter that THROWS "Custom types cannot be represented in JSON Schema",
 *                   in v6 and v7 alike
 *
 * What remains is `UIMessageChunk` in the package's own `.d.ts`, which is unaffected by
 * `strictObject` -> `looseObject` because a declaration does not have a validation mode.
 *
 * WHY A `.d.ts` IS THE RIGHT SOURCE HERE AND WAS THE WRONG ONE BEFORE. #929 read this same file
 * to ask *did the validation get looser*, and it could not answer: a declaration file has no way
 * to express a runtime validation mode, so no care taken with it would have reached the question.
 * This asks *what keys does the SDK declare for this chunk type*, which is precisely what a
 * declaration file is the authoritative record of. Same artifact, different question — the
 * earlier reading failed because it asked the source something the source cannot know, not
 * because the source is unreliable.
 *
 * NOT `frame-contract.ts`, DELIBERATELY. That module reads OUR contract, and is the right reader
 * for frames this repository EMITS. This one reads THEIRS, because the subject here is the
 * contract itself: pointing the contract at itself would accept 18 of 21 variants trivially and
 * fail the other 3 on a limitation of the instance builder. Two modules, two sources, opposite
 * directions.
 *
 * RESOLVED BY PACKAGE RESOLUTION, NEVER BY A RELATIVE PATH, because this suite runs in all five
 * eject rungs and an ejected tree's `node_modules` layout is not this repository's. `import.meta.url`
 * rather than `__dirname` on purpose: #1000 is moving the two existing `__dirname` sites in this
 * package, and a third would make that change larger.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const requireFrom = createRequire(import.meta.url);

/**
 * The union is expected to be large. A floor catches the shape that would otherwise be silent:
 * a parse that succeeds and yields almost nothing, which would make every comparison below pass
 * by having nothing to compare against.
 */
const MINIMUM_DECLARED_CHUNKS = 10;

/** The chunk type the SDK declares for app-defined data frames, as a template literal. */
const DATA_PREFIX = "data-";

function resolveDeclarationFile(): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFrom.resolve("ai/package.json");
  } catch {
    throw new Error(
      "cannot resolve `ai/package.json` from this module, so the SDK's declared chunk shapes " +
        "cannot be read and this guard has no verdict to report. It is resolved rather than " +
        "reached by relative path because this suite also runs inside the eject rungs."
    );
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
    exports?: { ["."]?: { types?: string } };
    types?: string;
    typings?: string;
  };
  const declared = pkg.exports?.["."]?.types ?? pkg.types ?? pkg.typings;
  if (typeof declared !== "string") {
    throw new Error(
      `\`ai\` at ${packageJsonPath} declares no types entry, so there are no declarations to read.`
    );
  }
  const file = path.resolve(path.dirname(packageJsonPath), declared);
  if (!fs.existsSync(file)) {
    throw new Error(
      `\`ai\` names ${declared} as its types entry but ${file} does not exist.`
    );
  }
  return file;
}

export const declarationFile: string = resolveDeclarationFile();

const source = ts.createSourceFile(
  declarationFile,
  fs.readFileSync(declarationFile, "utf-8"),
  ts.ScriptTarget.Latest,
  /* setParentNodes */ false,
  ts.ScriptKind.TS
);

function findTypeAlias(name: string): ts.TypeAliasDeclaration | null {
  let found: ts.TypeAliasDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name)
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The property names a type-literal node declares, and its `type: "..."` discriminator. */
function readLiteral(node: ts.TypeLiteralNode): {
  chunkType: string | null;
  keys: string[];
} {
  let chunkType: string | null = null;
  const keys: string[] = [];
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : null;
    if (name === null) continue;
    keys.push(name);
    if (
      name === "type" &&
      member.type &&
      ts.isLiteralTypeNode(member.type) &&
      ts.isStringLiteral(member.type.literal)
    ) {
      chunkType = member.type.literal.text;
    }
  }
  return { chunkType, keys };
}

function buildDeclaredChunks(): Map<string, ReadonlySet<string>> {
  const alias = findTypeAlias("UIMessageChunk");
  if (alias === null) {
    throw new Error(
      `${declarationFile} declares no \`UIMessageChunk\` type. The SDK's chunk union is the ` +
        `subject of this reader; without it there is nothing to compare a contract against.`
    );
  }
  if (!ts.isUnionTypeNode(alias.type)) {
    throw new Error(
      `\`UIMessageChunk\` is a ${
        ts.SyntaxKind[alias.type.kind]
      }, not a union. This reader walks the union's members; a different shape means the ` +
        `declaration changed and this file must be re-read rather than silently reporting less.`
    );
  }
  const byType = new Map<string, ReadonlySet<string>>();
  for (const member of alias.type.types) {
    if (!ts.isTypeLiteralNode(member)) continue;
    const { chunkType, keys } = readLiteral(member);
    if (chunkType !== null) byType.set(chunkType, new Set(keys));
  }
  if (byType.size < MINIMUM_DECLARED_CHUNKS) {
    throw new Error(
      `recovered only ${byType.size} declared chunk type(s) from ${declarationFile}, below the ` +
        `floor of ${MINIMUM_DECLARED_CHUNKS}. A parse that yields almost nothing would let every ` +
        `comparison pass for want of anything to compare against.`
    );
  }
  return byType;
}

/**
 * The top-level keys the SDK declares for an app-defined `data-*` frame.
 *
 * The union member for these is not a literal but `DataUIMessageChunk<DATA_TYPES>`, a mapped type
 * over the app's own payload map:
 *
 *     { type: `data-${NAME}`; id?: string; data: DATA_TYPES[NAME]; transient?: boolean }
 *
 * So the SDK declares exactly four keys for EVERY data frame and says nothing whatever about the
 * payload — `DATA_TYPES[NAME]` is this repository's shape, not the SDK's. That boundary is the
 * same one `frame-contract.ts` records from the other side: `additionalProperties: false` binds a
 * frame's own keys and does not reach inside `data`. Between them the two modules cover both
 * levels; neither covers both alone.
 */
function buildDataChunkKeys(): ReadonlySet<string> {
  const alias = findTypeAlias("DataUIMessageChunk");
  if (alias === null) {
    throw new Error(
      `${declarationFile} declares no \`DataUIMessageChunk\` type. Most of this repository's ` +
        `contract is \`data-*\` frames, so losing this member would silently drop them from the ` +
        `comparison rather than report less coverage.`
    );
  }
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertySignature(node) &&
      node.name &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      keys.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(alias);
  if (keys.size === 0) {
    throw new Error(
      `\`DataUIMessageChunk\` declares no properties, which would make every \`data-*\` frame's ` +
        `keys undeclared and every comparison meaningless.`
    );
  }
  return keys;
}

const declaredChunks = buildDeclaredChunks();
const dataChunkKeys = buildDataChunkKeys();

/** Every chunk type the SDK declares as a literal, sorted. Excludes the `data-*` template. */
export const declaredChunkTypes: readonly string[] = [
  ...declaredChunks.keys(),
].sort();

/**
 * The keys the SDK declares for one chunk type, or `null` when it declares no such chunk.
 *
 * NULL RATHER THAN AN EMPTY SET, matching `frame-contract.ts`'s distinction for the same reason:
 * a caller must be able to tell "declares nothing" from "is not declared at all". Reporting every
 * key of an undeclared chunk as undeclared would bury the one line that matters — that the SDK
 * has no such frame.
 */
export function declaredKeysFor(chunkType: string): ReadonlySet<string> | null {
  const literal = declaredChunks.get(chunkType);
  if (literal) return literal;
  if (chunkType.startsWith(DATA_PREFIX)) return dataChunkKeys;
  return null;
}

/**
 * The keys a frame carries that the SDK does not declare for its type, or `null` when the SDK
 * declares no such chunk type at all.
 *
 * A key here is one the client will not read. Under v6 that produced a rejected frame; under v7 it
 * produces a frame accepted with the value silently dropped, which is why the question is asked of
 * the declarations rather than of a validator.
 */
export function undeclaredKeys(
  chunkType: string,
  keys: readonly string[]
): string[] | null {
  const declared = declaredKeysFor(chunkType);
  if (declared === null) return null;
  return keys.filter((k) => !declared.has(k)).sort();
}
