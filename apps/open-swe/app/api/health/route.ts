import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest): Promise<Response> {
  return Response.json(
    { status: "ok" },
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
