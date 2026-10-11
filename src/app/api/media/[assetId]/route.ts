import { z } from "zod";
import { verifyMediaToken } from "@/studio/assets";
import { byteRange, mediaMetadata, mediaStream } from "@/studio/media";
import { rateLimit } from "@/studio/rate-limit";
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
    await rateLimit(owner);
    const metadata = await mediaMetadata(owner, id);
    const { mime, size } = metadata;
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
    };
    if (url.searchParams.get("download") === "1")
      headers["Content-Disposition"] = `attachment; filename="vidio${mode === "demo" ? "-demo" : ""}.mp4"`;
    const range = request.headers.get("range");
    const selected = byteRange(range,size);
    if (!selected) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${size}`,"Cache-Control":"private, no-store"}});
    const {start,end}=selected;
    if (range) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = String(end - start + 1);
    }
    const stream=await mediaStream(owner,id,metadata,selected,request.signal);
    return new Response(stream,{status:range ? 206 : 200,headers});
  } catch (error) {
    const failure = safeError(
      error instanceof z.ZodError
        ? new StudioError("NOT_FOUND", "Media not found", 404)
        : error,
    );
    return Response.json(failure.body, { status: failure.status });
  }
}
