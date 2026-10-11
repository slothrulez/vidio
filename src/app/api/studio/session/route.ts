import { NextResponse } from "next/server";
import { checkOrigin, publicOrigin, studioMode } from "@/studio/config";
import { actor, previewSession } from "@/studio/auth";
import { safeError } from "@/studio/service";
import { rateLimit } from "@/studio/rate-limit";
import { StudioError } from "@/studio/types";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const mode = studioMode();
    if (mode === "production") {
      await rateLimit(await actor(request));
      return NextResponse.json({ mode });
    }
    try {
      await rateLimit(await actor(request));
      return NextResponse.json({ mode: "demo" });
    } catch (error) {
      if (!(error instanceof StudioError) || error.code !== "AUTH") throw error;
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
