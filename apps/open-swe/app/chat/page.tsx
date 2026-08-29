/**
 * `/chat` — THE PREVIOUS ADDRESS OF THE FRONT DOOR (#154).
 *
 * The chat now lives at `/`. This file is kept, and kept thin, because every
 * conversation the sidebar has ever written to localStorage links here;
 * breaking those in the same change that moves the front door would mix a
 * routing decision with a migration and make a failure in either look like a
 * failure in the other.
 *
 * IT RE-EXPORTS RATHER THAN REDIRECTS. A redirect would be a round trip to say
 * something the router already knows, and it would drop the `?framework=` and
 * `?c=` query that is the entire content of these links.
 *
 * AND IT IS NOT A TRAPDOOR. `selectFramework` rebuilds the URL from
 * `usePathname()`, not from a literal `/` — a literal makes the switch a ROUTE
 * change for anyone who arrived here, Next remounts across routes, and the
 * conversation dies on the first framework switch. That defect shipped to CI
 * on this branch and only the switch-separator e2e suite caught it, because it
 * is the one place a conversation exists to be lost.
 *
 * Nothing this app renders links to `/chat` any more, so this address is
 * reachable only from a link that predates the move, and it can be deleted
 * once those are gone.
 */
export { default } from "../page";
