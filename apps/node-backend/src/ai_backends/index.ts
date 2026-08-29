/**
 * The barrel of AI backends — and the reason it exists is severability, not tidiness.
 *
 * `pnpm eject langchain` DELETES ai_backends/langgraph.ts. A registry that
 * imported that module directly would then hold a dangling import, and eject
 * refuses rather than shipping a fork that cannot boot:
 *
 *   FAIL: ejecting to "langchain" would leave 1 dangling reference(s):
 *          registry.ts imports "./ai_backends/langgraph.js", which this eject deleted
 *
 * That is eject's own guard, and it caught this file's absence — the first
 * version of registry.ts imported each rung by name and asserted eject would
 * prune it. It does not: the pruning that exists is for the two PYTHON
 * registries and is Python-specific.
 *
 * What eject DOES prune, generically, is a barrel re-export whose target no
 * longer exists. So the rung modules are reached through one, and this file is
 * the only place any of them is named. Ejecting a rung deletes its module and
 * prunes the line below that pointed at it, and nothing else has to change —
 * which is the property `registry.ts` needs and could not provide by itself.
 *
 * ADDING A RUNG IS ONE LINE HERE. Do not add an import anywhere else: a module
 * named inside a function body is not pruned by anything, and that is exactly
 * how main.py came to die at boot with `NameError: name 'deepagents' is not
 * defined` — the whole backend, not one rung.
 */
export * as langchain from "./langchain.js";
export * as langgraph from "./langgraph.js";
export * as deepagents from "./deepagents.js";
