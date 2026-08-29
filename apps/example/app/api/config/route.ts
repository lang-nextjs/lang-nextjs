export const dynamic = "force-dynamic";

/**
 * WHICH RUNTIMES THIS DEPLOYMENT CAN REACH.
 *
 * `node` joined on #360, and it had to join HERE as well as in the surface.
 * apps/example renders its runtime list from `RUNTIMES`, and gates each entry
 * on this map — so adding a value to the list without adding it here produced a
 * button that was permanently disabled by an absent key rather than by a real
 * answer. The two failure modes render identically: `availableRuntimes["node"]`
 * is `undefined` whether the deployment has no NODE_URL or whether this route
 * simply never mentions node.
 *
 * That is the same defect #360 exists to remove, one file along: a runtime the
 * UI offers and the config cannot speak about. apps/open-swe has its own copy
 * of this endpoint — see the note in app/api/chat/stream/route.ts about the
 * duplication, which is filed rather than fixed here.
 */
export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      backends: {
        django: !!process.env.DJANGO_URL,
        fastapi: !!process.env.FASTAPI_URL,
        node: !!process.env.NODE_URL,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
