import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ACCESS_COOKIE_NAME, getExpectedAccessToken, isAccessGateEnabled } from "@/lib/auth-gate";

export async function GET() {
  const enabled = isAccessGateEnabled();
  if (!enabled) {
    return NextResponse.json({ enabled: false, authenticated: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? "";
  const authenticated = token.length > 0 && token === getExpectedAccessToken();
  return NextResponse.json({ enabled: true, authenticated }, { headers: { "Cache-Control": "no-store" } });
}
