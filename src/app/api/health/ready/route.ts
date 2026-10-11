import { checkReadiness } from "@/studio/health";
import { studioMode } from "@/studio/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await checkReadiness(studioMode());
    return Response.json(
      { status: ready ? "ready" : "not_ready" },
      {
        status: ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { status: "not_ready" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
