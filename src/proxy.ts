import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const mode = process.env.VIDIO_MODE;
  const isolated =
    mode === "demo" || mode === "production" ||
    (mode !== undefined && mode !== "legacy") ||
    process.env.NODE_ENV === "production" || process.env.COZE_PROJECT_ENV === "PROD";
  if (
    isolated &&
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/studio/") &&
    !pathname.startsWith("/api/media/")
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Legacy provider and file APIs are disabled in managed studio modes. Use the authenticated studio job APIs.",
      },
      { status: 503 },
    );
  }
  return NextResponse.next();
}
export const config = { matcher: "/api/:path*" };
