import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { getProject, saveProject } from "./store";
import { registerAsset, validateImage } from "./assets";
import { StudioError } from "./types";

export const uploadSchemas = {
  abort_image_upload: z.object({ uploadId: z.uuid() }).strict(),
  begin_image_upload: z
    .object({
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      mime: z.enum(["image/png", "image/jpeg"]),
      size: z.number().int().min(24).max(5_000_000),
    })
    .strict(),
  append_image_chunk: z
    .object({
      uploadId: z.uuid(),
      offset: z.number().int().min(0).max(5_000_000),
      data: z
        .string()
        .min(4)
        .max(262_144)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  finish_image_upload: z.object({ uploadId: z.uuid() }).strict(),
};
export type UploadTool = keyof typeof uploadSchemas;
export async function executeUpload(
  owner: string,
  name: UploadTool,
  args: unknown,
) {
  return transaction(async (client) => {
    if (name === "abort_image_upload") {
      const input = uploadSchemas.abort_image_upload.parse(args);
      await client.query(
        "DELETE FROM vidio_image_uploads WHERE id=$1 AND owner_id=$2 AND asset_id IS NULL",
        [input.uploadId, owner],
      );
      return {};
    }
    if (name === "begin_image_upload") {
      const input = uploadSchemas.begin_image_upload.parse(args);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [owner]);
      await client.query("SELECT pg_advisory_xact_lock(4112030)");
      await client.query(
        "DELETE FROM vidio_image_uploads WHERE expires_at<now()",
      );
      const reserved = await client.query(
        "SELECT coalesce(sum(expected_size),0)::bigint AS n FROM vidio_image_uploads WHERE asset_id IS NULL",
      );
      if (
        Number(reserved.rows[0].n) + input.size >
        (process.env.VIDIO_MODE === "production" ? 1_000_000_000 : 150_000_000)
      )
        throw new StudioError(
          "LIMIT",
          "Temporary upload capacity reached; try again shortly",
          429,
        );
      await client.query(
        "SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [input.projectId, owner],
      );
      const project = await getProject(owner, input.projectId, client);
      if (
        project.revision !== input.revision ||
        project.activeJobId ||
        project.stage !== "new"
      )
        throw new StudioError(
          "REVISION",
          "Upload images before identifying the product; create a new project to change its photos",
          409,
        );
      const existing =
        project.imageAssetIds ??
        (project.imageAssetId ? [project.imageAssetId] : []);
      const pending = await client.query(
        "SELECT count(*)::int AS owned,count(*) FILTER(WHERE project_id=$2)::int AS n FROM vidio_image_uploads WHERE owner_id=$1 AND asset_id IS NULL",
        [owner, project.id],
      );
      if (
        pending.rows[0].owned >= 6 ||
        existing.length + pending.rows[0].n >= 6
      )
        throw new StudioError("LIMIT", "Use up to six product images", 429);
      const result = await client.query(
        "INSERT INTO vidio_image_uploads(id,project_id,owner_id,revision,mime,expected_size) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,expires_at",
        [
          randomUUID(),
          project.id,
          owner,
          project.revision,
          input.mime,
          input.size,
        ],
      );
      return {
        upload: {
          id: String(result.rows[0].id),
          offset: 0,
          expiresAt: new Date(result.rows[0].expires_at).toISOString(),
        },
      };
    }
    const append =
      name === "append_image_chunk"
        ? uploadSchemas.append_image_chunk.parse(args)
        : undefined;
    const uploadId =
      append?.uploadId ??
      uploadSchemas.finish_image_upload.parse(args).uploadId;
    const found = await client.query(
      "SELECT * FROM vidio_image_uploads WHERE id=$1 AND owner_id=$2 AND expires_at>now() FOR UPDATE",
      [uploadId, owner],
    );
    if (!found.rows.length)
      throw new StudioError(
        "UPLOAD_EXPIRED",
        "Upload expired or not found; select the file again",
        404,
      );
    const row = found.rows[0];
    const data: Buffer = row.data;
    if (append) {
      const input = append;
      if (row.asset_id)
        throw new StudioError("UPLOAD", "Upload already completed", 409);
      const chunk = Buffer.from(input.data, "base64");
      if (
        !chunk.length ||
        chunk.toString("base64") !== input.data ||
        (data.length + chunk.length > row.expected_size &&
          input.offset === data.length)
      )
        throw new StudioError("UPLOAD", "Invalid image chunk or size", 413);
      if (
        input.offset < data.length &&
        data.subarray(input.offset, input.offset + chunk.length).equals(chunk)
      )
        return {
          upload: {
            id: row.id,
            offset: data.length,
            expiresAt: new Date(row.expires_at).toISOString(),
          },
        };
      if (
        input.offset !== data.length ||
        data.length + chunk.length > row.expected_size
      )
        throw new StudioError("UPLOAD", "Upload offset mismatch", 409);
      await client.query(
        "UPDATE vidio_image_uploads SET data=data||$2::bytea WHERE id=$1",
        [row.id, chunk],
      );
      return {
        upload: {
          id: row.id,
          offset: data.length + chunk.length,
          expiresAt: new Date(row.expires_at).toISOString(),
        },
      };
    }
    await client.query(
      "SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [row.project_id, owner],
    );
    const project = await getProject(owner, row.project_id, client);
    if (row.asset_id) return { project };
    if (
      project.revision !== row.revision ||
      project.activeJobId ||
      project.stage !== "new"
    )
      throw new StudioError(
        "REVISION",
        "Project changed while uploading; select the file again",
        409,
      );
    if (data.length !== row.expected_size)
      throw new StudioError("UPLOAD", "Image upload is incomplete", 409);
    validateImage(data, row.mime);
    const assetId = await registerAsset(
      owner,
      project.id,
      row.mime,
      data,
      client,
    );
    project.imageAssetIds = [
      ...(project.imageAssetIds ??
        (project.imageAssetId ? [project.imageAssetId] : [])),
      assetId,
    ];
    project.imageAssetId ??= assetId;
    project.revision++;
    await saveProject(owner, project, client);
    await client.query(
      "UPDATE vidio_image_uploads SET asset_id=$2,data=''::bytea WHERE id=$1",
      [row.id, assetId],
    );
    return { project };
  });
}
