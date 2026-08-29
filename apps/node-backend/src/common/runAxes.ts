/**
 * WHAT THIS RUN IS — recorded once per request, read wherever tracing attaches.
 *
 * The Python planes do this with a `contextvars.ContextVar` because the axes
 * are known in the dispatch and needed a dozen call sites away, every one of
 * them inside a `config=` kwarg. `AsyncLocalStorage` is Node's equivalent and
 * has the property that matters: it is per-async-context, so two concurrent
 * requests each see their own axes where a module-level global would let the
 * second overwrite the first mid-stream.
 *
 * `runtime` for this process is "node" — a third value beside "fastapi" and
 * "django". Without it, node traces arrive untagged while the other two are
 * filterable, which is the divergence #171 removed and #118 before it.
 *
 * NOT COVERED BY `pnpm check:run-axes-parity`, and that is a decision rather
 * than an omission — see the note in README.md. That checker asserts the two
 * PYTHON planes' `set_run_axes` / `langfuse_trace_metadata` are BYTE-IDENTICAL,
 * which is the right test for two copies of the same Python source and is not
 * expressible against a TypeScript port. What is enforced instead is the
 * behaviour: runAxes.test.ts pins the tag vocabulary (`axis:value`, sorted) and
 * the session key (`langfuse_session_id`) against literals taken from the
 * Python, so a drift in the OUTPUT still fails even though the source cannot be
 * compared.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunAxes {
  runtime?: string;
  framework?: string;
  topology?: string;
  session?: string;
}

const storage = new AsyncLocalStorage<RunAxes>();

/**
 * Run `fn` with these axes in scope.
 *
 * Values that are falsey are DROPPED rather than recorded — an absent axis and
 * an axis whose value is the string "None"/"undefined" are different facts, and
 * only one of them is true. Straight port of the Python comment.
 */
export function withRunAxes<T>(axes: RunAxes, fn: () => T): T {
  const kept: RunAxes = {};
  for (const [k, v] of Object.entries(axes)) {
    if (v) kept[k as keyof RunAxes] = v as string;
  }
  return storage.run(kept, fn);
}

export function currentRunAxes(): RunAxes {
  return storage.getStore() ?? {};
}

/**
 * Tags and session for the current request, in Langfuse's own vocabulary.
 *
 * Tags are `axis:value` so Langfuse's tag filter groups them: `framework:
 * langchain` selects a framework across every topology and `topology:react`
 * cuts the other way across every framework. That second cut is the comparison
 * this repo exists to make.
 *
 * `session` is pulled out rather than tagged, because a session is an identity,
 * not an axis. The key names are the ones langfuse's own CallbackHandler reads.
 */
export function traceMetadata(): Record<string, unknown> {
  const axes = { ...currentRunAxes() };
  const session = axes.session;
  delete axes.session;
  const entries = Object.entries(axes).filter(([, v]) => Boolean(v));
  if (entries.length === 0 && !session) return {};
  const md: Record<string, unknown> = {};
  if (entries.length > 0) {
    md.langfuse_tags = entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}:${v}`);
  }
  if (session) md.langfuse_session_id = session;
  return md;
}

/**
 * `config` for a graph invocation. `{}` when there is nothing to say.
 *
 * Returning `{}` rather than `{callbacks: []}` matters for the same reason it
 * does in Python: an empty callbacks list REPLACES inherited callbacks on
 * nested runs, so the empty-but-present form would actively suppress tracing a
 * parent had set up.
 *
 * NO LANGFUSE HANDLER IS ATTACHED HERE, and observability.ts reports that
 * honestly rather than claiming support this file does not provide.
 */
export function runConfig(): Record<string, unknown> {
  const md = traceMetadata();
  return Object.keys(md).length > 0 ? { metadata: md } : {};
}
