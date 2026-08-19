export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      backends: {
        django: !!process.env.DJANGO_URL,
        fastapi: !!process.env.FASTAPI_URL,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
