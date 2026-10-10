import { NextResponse } from "next/server";
import { checkOrigin, publicOrigin } from "@/studio/config";
import { actor, previewSession } from "@/studio/auth";
import { safeError } from "@/studio/service";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    try {
      await actor(request);
      return NextResponse.json({ mode: "demo" });
    } catch {
      /* Bootstrap only the explicit demo mode. */
    }
    const token = await previewSession();
    const response = NextResponse.json({ mode: "demo" });
    response.cookies.set("vidio_preview", token, {
      httpOnly: true,
      secure: publicOrigin().startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 3600,
    });
    return response;
  } catch (error) {
    const failure = safeError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
