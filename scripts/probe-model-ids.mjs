#!/usr/bin/env node
/**
 * probe-model-ids.mjs — do the model ids we OFFER still resolve at their provider? (#1174)
 *
 * THE DEFECT. `rungs/5-software-developer-agent/.../open-swe/models.ts` offers ids for selection
 * and nothing checks that any of them still resolves. One of them is the sibling of the id that
 * took main red in #1152 (`openai:gpt-4o-mini`, retired by OpenRouter), and a retired id fails as
 * a 404 that the live-transport classifier stamps UPSTREAM_UNAVAILABLE and downgrades to "not a
 * defect in this repository".
 *
 * WHY THIS IS A SCHEDULED PROBE AND NOT A GATE. It needs the network, so it cannot be an ordinary
 * check. It is also not a pass/fail over one tree: each provider is asked separately and answers
 * separately.
 *
 * THE VOCABULARY IS PER PROVIDER, which is the whole design (ARCHITECT's ruling on #1174):
 *
 *     0  holds          every id this provider offers is in its catalogue
 *     1  violated       an offered id is NOT in the catalogue
 *     2  could not ask  no credential, or the catalogue did not answer
 *
 * A run that collapses three providers into one status would report on a set it did not examine —
 * and today two of the three CANNOT be asked, because this repository holds no OpenAI or Google
 * credential. So the honest output names, every run, how many ids were checked and how many were
 * unaskable. That count is the most useful thing this probe emits: it turns a blind spot into a
 * number, and it is why the probe is worth running before the missing credentials are decided.
 *
 * THE CATALOGUE IS THE PROVIDER'S, NEVER A LIST OF OURS. A hardcoded set of valid ids would be the
 * artefact this exists to check, one layer up, going stale identically.
 *
 * A COMMENTED-OUT ENTRY IS NOT OFFERED. The file carries two `// value: "anthropic:extended-
 * thinking:..."` lines behind a "TODO: Test these then re-enable". #1174's body counts them and
 * says 21; its title says 19. The title is right: a comment is not a call site, and a probe that
 * reported on ids nobody can select would be measuring the wrong set.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MODELS_FILE = join(
  "rungs",
  "5-software-developer-agent",
  "packages",
  "shared",
  "src",
  "open-swe",
  "models.ts"
);

/** Every id the menu OFFERS: `value: "..."` on a line that is not commented out. */
export function offeredIds(source) {
  const out = [];
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("//")) continue;
    const m = /value:\s*"([^"]+)"/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** `provider:rest` — the menu's colon form, which is not the slash form #1152 was about. */
export const providerOf = (id) => id.split(":")[0];
export const modelOf = (id) => id.slice(id.indexOf(":") + 1);

/**
 * Each provider's catalogue endpoint and the credential it needs. The URL is the provider's own
 * list API — what it currently serves, rather than what we once wrote down.
 */
export const PROVIDERS = {
  anthropic: {
    key: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    ids: (body) => (body?.data ?? []).map((m) => m.id),
  },
  openai: {
    key: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/models",
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    ids: (body) => (body?.data ?? []).map((m) => m.id),
  },
  "google-genai": {
    key: "GOOGLE_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: () => ({}),
    keyInQuery: true,
    ids: (body) =>
      (body?.models ?? []).map((m) =>
        String(m.name ?? "").replace(/^models\//, "")
      ),
  },
};

/**
 * One provider's verdict. `fetchImpl` and `env` are injected so the selftest can drive every
 * outcome without a network or a credential.
 */
export async function askProvider(provider, wanted, { env, fetchImpl }) {
  const spec = PROVIDERS[provider];
  if (!spec)
    return {
      status: 2,
      why: `no catalogue endpoint is declared for "${provider}"`,
      wanted,
    };
  const key = env[spec.key];
  if (!key)
    return {
      status: 2,
      why: `no ${spec.key} in this environment, so its catalogue cannot be asked`,
      wanted,
    };
  let catalogue;
  try {
    const url = spec.keyInQuery ? `${spec.url}&key=${key}` : spec.url;
    const res = await fetchImpl(url, { headers: spec.headers(key) });
    if (!res.ok)
      return {
        status: 2,
        why: `catalogue answered HTTP ${res.status}`,
        wanted,
      };
    catalogue = spec.ids(await res.json());
  } catch (e) {
    return {
      status: 2,
      why: `catalogue could not be read: ${e.message}`,
      wanted,
    };
  }
  if (!Array.isArray(catalogue) || catalogue.length === 0)
    return {
      status: 2,
      why: "catalogue came back empty, which is not an answer",
      wanted,
    };
  const missing = wanted.filter((id) => !catalogue.includes(modelOf(id)));
  return missing.length
    ? {
        status: 1,
        why: `${missing.length} offered id(s) are not in the catalogue`,
        wanted,
        missing,
        catalogue: catalogue.length,
      }
    : {
        status: 0,
        why: `all ${wanted.length} offered id(s) are in the catalogue`,
        wanted,
        catalogue: catalogue.length,
      };
}

/** The whole probe, as data. `main()` only renders and picks an exit code. */
export async function probe({
  cwd = ROOT,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const path = join(cwd, MODELS_FILE);
  if (!existsSync(path))
    return {
      subjectAbsent: true,
      path: MODELS_FILE,
      providers: {},
      offered: [],
    };
  const offered = offeredIds(readFileSync(path, "utf8"));
  const byProvider = {};
  for (const id of offered) (byProvider[providerOf(id)] ??= []).push(id);
  const providers = {};
  for (const [p, ids] of Object.entries(byProvider))
    providers[p] = await askProvider(p, ids, { env, fetchImpl });
  return { subjectAbsent: false, path: MODELS_FILE, providers, offered };
}

/**
 * THE RUN'S EXIT CODE, which is NOT simply the worst provider status.
 *
 *   1  some provider ANSWERED and an offered id was absent — a real finding about the menu
 *   2  NOTHING could be asked: no provider answered, so the run measured nothing at all
 *   0  at least one provider answered and none reported a missing id
 *
 * Exit 0 while providers are unaskable is deliberate. Today two of three cannot be asked, and a
 * probe that exited 2 every week would be a red nobody reads — the outcome #1174 warns about for
 * the grep it replaces. The unaskable count is REPORTED on every run instead, so the gap is a
 * number rather than a permanent failure.
 */
export function renderAndRank(result) {
  const lines = [];
  if (result.subjectAbsent) {
    lines.push(
      `SUBJECT ABSENT: ${result.path} is not in this tree, so no model id was checked.`,
      `      That is rung 5 not being present, which is different from present-and-unchecked.`
    );
    return { code: 0, out: lines.join("\n") };
  }
  const entries = Object.entries(result.providers);
  /*
   * AN EMPTY OFFERED SET IS A REFUSAL, NOT A PASS (DEV1, reviewing). `offeredIds` matches a regex
   * over non-comment lines, so a reformat or a quote change returns [] — and ranking that 0 printed
   * "every id ... is in its provider's catalogue", vacuously true over zero ids, because
   * `noneAnswered` requires `entries.length > 0`. The repository already has the convention:
   * `assert-single-instance` REFUSES rather than passing on an empty sweep.
   *
   * The workflow happens to be protected — its selftest step runs first and that suite's control
   * arm requires the real menu to parse to more than five ids — but that protection lives one step
   * away and said nothing here, so the probe alone was not protected.
   */
  if (result.offered.length === 0)
    return {
      code: 2,
      out:
        `COULD NOT CHECK: ${result.path} is present but parsed to ZERO offered ids.\n` +
        `      That is a parse that found nothing, not a menu with nothing on it — exit 2, because\n` +
        `      "no id could be read" is a different answer from "every id resolves".`,
    };
  const checked = entries
    .filter(([, r]) => r.status !== 2)
    .flatMap(([, r]) => r.wanted).length;
  const unaskable = entries
    .filter(([, r]) => r.status === 2)
    .flatMap(([, r]) => r.wanted).length;
  lines.push(
    `SUBJECT: ${result.offered.length} model id(s) offered by ${result.path}, ` +
      `${checked} checked against a provider catalogue, ${unaskable} unaskable.`
  );
  for (const [p, r] of entries) {
    const word =
      r.status === 0 ? "holds" : r.status === 1 ? "VIOLATED" : "COULD NOT ASK";
    lines.push(
      `  ${p.padEnd(14)} ${String(r.status)} ${word.padEnd(14)} ${r.why}`
    );
    for (const id of r.missing ?? []) lines.push(`      MISSING: ${id}`);
  }
  const violated = entries.some(([, r]) => r.status === 1);
  const noneAnswered =
    entries.length > 0 && entries.every(([, r]) => r.status === 2);
  if (violated)
    lines.push(
      ``,
      `FAIL: an id this menu offers is not in its provider's catalogue. A retired id fails as a`,
      `      404 that the live-transport classifier stamps UPSTREAM_UNAVAILABLE — "not a defect in`,
      `      this repository" — which is how #1152 stayed invisible.`
    );
  else if (noneAnswered)
    lines.push(
      ``,
      `COULD NOT CHECK: no provider answered, so this run measured nothing. Exit 2, not 0 —`,
      `      "nobody could be asked" is a different answer from "every id resolves".`
    );
  else
    lines.push(
      ``,
      `OK: every id that could be asked about is in its provider's catalogue.` +
        (unaskable
          ? ` ${unaskable} id(s) could not be asked; see the per-provider lines above.`
          : ``)
    );
  return { code: violated ? 1 : noneAnswered ? 2 : 0, out: lines.join("\n") };
}

import { invokedAsProgram } from "./lib/is-main.mjs";
if (invokedAsProgram(import.meta.url)) {
  const result = await probe();
  const { code, out } = renderAndRank(result);
  (code === 0 ? process.stdout : process.stderr).write(`\n${out}\n\n`);
  process.exit(code);
}
