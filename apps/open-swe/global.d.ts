// Ambient declaration for plain (non-module) stylesheet side-effect imports,
// e.g. `import "./globals.css"` in app/layout.tsx.
//
// Required because TypeScript 6 turns on `noUncheckedSideEffectImports` by
// DEFAULT, which makes a side-effect import resolve like any other import.
// Next 16 ships `declare module '*.css' {}` in its own types/global.d.ts;
// Next 15.x ships only the `*.module.css` variants. Without this file the app
// typechecks under Next 16 and fails under Next 15 — which is exactly what the
// Cross-Version Matrix caught.
//
// apps/example has carried this same one-line file since the initial commit;
// apps/open-swe was added later without it. Keep the two in step.
declare module "*.css";
