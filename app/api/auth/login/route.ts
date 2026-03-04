import { NextRequest, NextResponse } from "next/server";
import {
  ACCESS_COOKIE_NAME,
  buildAccessTokenFromPassword,
  getConfiguredAccessPassword,
  getExpectedAccessToken,
  isAccessGateEnabled,
} from "@/lib/auth-gate";

export async function POST(req: NextRequest) {
  if (!isAccessGateEnabled()) {
    const res = NextResponse.json({ ok: true, enabled: false });
    res.cookies.delete(ACCESS_COOKIE_NAME);
    return res;
  }

  let password = "";
  try {
    const body = (await req.json()) as { password?: string };
    password = String(body.password ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const configured = getConfiguredAccessPassword();
  if (!configured) {
    return NextResponse.json({ error: "Access gate is disabled" }, { status: 400 });
  }

  if (password !== configured) {
    return NextResponse.json({ error: "密码错误" }, { status: 401 });
  }

  const token = buildAccessTokenFromPassword(password);
  const expected = getExpectedAccessToken();
  if (token !== expected) {
    return NextResponse.json({ error: "Token build failed" }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, enabled: true });
  res.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
