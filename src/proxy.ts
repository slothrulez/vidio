import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    process.env.VIDIO_MODE === "demo" &&
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/studio/") &&
    !pathname.startsWith("/api/media/")
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Legacy provider and file APIs are disabled in demo mode. Use the safe studio preview.",
      },
      { status: 503 },
    );
  }
  return NextResponse.next();
}
export const config = { matcher: "/api/:path*" };
