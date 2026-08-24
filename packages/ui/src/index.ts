/**
 * @deepagents-nextjs/ui — rung-agnostic UI primitives.
 *
 * THE BOUNDARY RULE (this is #17's rule, one layer up):
 * this package exports ONLY what has no rung in its name.
 *
 * Primitives — button, card, dialog, badge, scroll-area — are infrastructure,
 * the UI analogue of accumulator/handler/transforms. They are `shared` in the
 * rung manifest and survive every eject.
 *
 * Rung-local COMPOSITIONS do not belong here. A tool-call card, a plan panel,
 * a run-list row name a rung's concepts and live inside that rung's boundary.
 * If a component's name — or its props — mentions a plan, a todo, a run, a
 * sub-agent, an approval, or a framework, it is not a primitive.
 *
 * The failure this prevents: a renderer classified `shared` outlives the only
 * code that can produce the data it renders, and an ejected repo ships dead UI
 * as infrastructure. That is not hypothetical — see packages/react's card
 * exports, whose payloads only deepagentsEnrich (rung 3) and openSweEnrich
 * (rung 4) emit.
 */

export * from "./components/ui/avatar";
export * from "./components/ui/badge";
export * from "./components/ui/breadcrumb";
export * from "./components/ui/button";
export * from "./components/ui/card";
export * from "./components/ui/dialog";
export * from "./components/ui/dropdown-menu";
export * from "./components/ui/input";
export * from "./components/ui/label";
export * from "./components/ui/scroll-area";
export * from "./components/ui/separator";
export * from "./components/ui/sheet";
export * from "./components/ui/sidebar";
export * from "./components/ui/skeleton";
export * from "./components/ui/table";
export * from "./components/ui/tabs";
export * from "./components/ui/tooltip";

export { cn } from "./lib/utils";
