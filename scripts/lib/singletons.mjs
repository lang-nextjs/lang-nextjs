/**
 * The modules whose IDENTITY matters — ones holding module-level state, or used
 * with `instanceof` across a package boundary, where two installed copies are
 * two different types that compare unequal on structurally perfect values.
 *
 * This list lives here rather than inside the checker so that
 * assert-single-instance.mjs and its selftest read the SAME array. When the two
 * were separate, the selftest's synthetic lockfile enumerated the singletons by
 * hand, and a name added here would have been absent there — the fixture would
 * have gone on passing while covering one fewer module than the checker claims.
 *
 * Adding a package here is cheap. Leaving one out is what produced the zod
 * split (#222) and the doubled `ai` (#933).
 */
export const SINGLETONS = ["react", "react-dom", "zod", "ai"];
