import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    ["demo", "production"].includes(process.env.VIDIO_MODE ?? "") &&
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
