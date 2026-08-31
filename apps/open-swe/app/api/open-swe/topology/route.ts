import {
  listGraphIds,
  CircuitOpenError,
} from "../../../../lib/langgraph-client";
import { classifyTopology } from "../../../../lib/backend-topology";
import type { BackendTopology } from "../../../../lib/backend-topology";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-swe/topology — does the connected backend run one graph or more?
 *
 * Returns 200 with a BackendTopology in EVERY case, including the failures.
 *
 * THE STATUS CODE IS NOT THE ANSWER HERE, and that is deliberate rather than
 * sloppy. "I could not reach the backend" is a legitimate, renderable topology
 * state — the view has to say it could not establish completeness — so it is
 * carried in the body as `{ known: false, reason }`. Returning 502 would push
 * the caller into a catch, and a caller's catch is where "unknown" quietly
 * becomes "nothing to show", which is the exact collapse #423 is about. The
 * probe always answers; what varies is whether the answer is knowledge.
 *
 * This is the only route in this app that does that, so it is worth being loud:
 * every other route models failure as an error because its failure means the
 * page cannot render. This one's failure IS something to render.
 */
export async function GET(): Promise<Response> {
  const json = (body: BackendTopology) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const platformUrl = process.env.LANGGRAPH_PLATFORM_URL;
  if (!platformUrl) {
    return json({
      known: false,
      reason: "LANGGRAPH_PLATFORM_URL is not configured",
    });
  }

  try {
    return json(classifyTopology(await listGraphIds(platformUrl)));
  } catch (err) {
    /*
     * An open circuit is not evidence about the backend's topology — it is
     * evidence that we have stopped asking. Reported as unknown, like any other
     * failure to ask, rather than as a graph count of zero.
     */
    const reason =
      err instanceof CircuitOpenError
        ? "the backend circuit is open"
        : err instanceof Error
        ? err.message
        : "the backend could not be reached";
    return json({ known: false, reason });
  }
}
