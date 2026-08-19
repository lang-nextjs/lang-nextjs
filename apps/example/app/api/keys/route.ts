import { generateApiKey, listKeys } from "@/lib/api-key-store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim() || "unnamed";

  const { meta, plainKey } = generateApiKey(name);

  return NextResponse.json(
    {
      id: meta.id,
      name: meta.name,
      prefix: meta.prefix,
      key: plainKey,
      createdAt: meta.createdAt,
    },
    { status: 201 }
  );
}

export async function GET(): Promise<NextResponse> {
  const keys = listKeys().map((m) => ({
    id: m.id,
    name: m.name,
    prefix: m.prefix,
    createdAt: m.createdAt,
    revokedAt: m.revokedAt,
  }));
  return NextResponse.json({ keys });
}
