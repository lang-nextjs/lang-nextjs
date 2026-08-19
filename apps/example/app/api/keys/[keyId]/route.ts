import { revokeKey } from "@/lib/api-key-store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> }
): Promise<NextResponse> {
  const { keyId } = await params;
  const meta = revokeKey(keyId);
  if (!meta) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: meta.id,
    name: meta.name,
    revokedAt: meta.revokedAt,
  });
}
