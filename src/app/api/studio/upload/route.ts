import { NextResponse } from "next/server";
import { actor } from "@/studio/auth";
import { checkOrigin, studioMode } from "@/studio/config";
import { getProject, saveProject } from "@/studio/store";
import { transaction } from "@/studio/db";
import { registerAsset, validateImage, projectMedia } from "@/studio/assets";
import { StudioError } from "@/studio/types";
import { safeError } from "@/studio/service";
import { z } from "zod";
import { boundedBody } from "@/studio/request";
import { rateLimit } from "@/studio/rate-limit";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const mode = studioMode();
    checkOrigin(request);
    const owner = await actor(request);
    await rateLimit(owner);
    if (Number(request.headers.get("content-length")) > 5_100_000)
      throw new StudioError("SIZE", "Upload exceeds 5 MB", 413);
    const body = await boundedBody(request, 5_100_000);
    const form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body,
    }).formData();
    const id = z.uuid().parse(form.get("projectId"));
    const revision = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(form.get("revision"));
    const image = form.get("image");
    if (!(image instanceof File) || image.size > 5_000_000)
      throw new StudioError("UPLOAD", "Upload a PNG or JPEG under 5 MB");
    const buffer = Buffer.from(await image.arrayBuffer());
    await validateImage(buffer, image.type);
    const project = await transaction(async (client) => {
      await client.query(
        "SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      );
      const project = await getProject(owner, id, client);
      if (project.revision !== revision || project.activeJobId)
        throw new StudioError(
          "REVISION",
          "Project changed or a job is active; refresh first",
          409,
        );
      project.imageAssetId = await registerAsset(
        owner,
        id,
        image.type,
        buffer,
        client,
      );
      project.imageAssetIds = [project.imageAssetId];
      project.stage = "new";
      project.features = [];
      project.scripts = [];
      project.segments = [];
      delete project.finalAssetId;
      delete project.captionAssetId;
      delete project.voiceAssetId;
      project.revision++;
      await saveProject(owner, project, client);
      return project;
    });
    return NextResponse.json({
      structuredContent: {
        mode,
        project,
        message:
          mode === "demo" ? "Image uploaded privately. Demo recognition is a fixture, not an image analysis." : "Image uploaded privately. Production recognition requires a configured live adapter.",
      },
      _meta: { media: await projectMedia(owner, project) },
    });
  } catch (error) {
    const failure = safeError(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
