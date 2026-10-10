import { z } from "zod";
import { verifyMediaToken, readAsset } from "@/studio/assets";
import { StudioError } from "@/studio/types";
import { safeError } from "@/studio/service";
import { studioMode } from "@/studio/config";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    const mode=studioMode();
    const id = z.uuid().parse((await params).assetId),
      url = new URL(request.url);
    const owner = await verifyMediaToken(
      url.searchParams.get("token") ?? "",
      id,
    );
    const { buffer, mime, size } = await readAsset(owner, id);
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
    };
    if (url.searchParams.get("download") === "1")
      headers["Content-Disposition"] = `attachment; filename="vidio${mode === "demo" ? "-demo" : ""}.mp4"`;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : size,
        end = match?.[2] ? Number(match[2]) : size - 1;
      if (start > end || start >= size || end >= size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = String(end - start + 1);
      return new Response(new Uint8Array(buffer.subarray(start, end + 1)), {
        status: 206,
        headers,
      });
    }
    return new Response(new Uint8Array(buffer), { headers });
  } catch (error) {
    const failure = safeError(
      error instanceof z.ZodError
        ? new StudioError("NOT_FOUND", "Media not found", 404)
        : error,
    );
    return Response.json(failure.body, { status: failure.status });
  }
}
