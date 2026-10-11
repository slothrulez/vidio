import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { database } from "./db";
import { transaction } from "./db";
import type { PoolClient } from "pg";
import { signingKey, publicOrigin } from "./config";
import { productionObjectStore, objectKey, MAX_ASSET_BYTES } from "./object-store";
import { StudioError, type StudioProject } from "./types";

export const assetsDirectory = () =>
  path.join(process.cwd(), ".vidio", "assets");
export function assetPath(id: string) {
  return path.join(assetsDirectory(), z.uuid().parse(id));
}
let writes = 0;
let decoders = 0;

export async function validateImage(buffer: Buffer, mime: string) {
  if (buffer.length < 24 || buffer.length > 5_000_000)
    throw new StudioError("UPLOAD", "Upload a PNG or JPEG under 5 MB");
  let width = 0,
    height = 0;
  if (
    mime === "image/png" &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (mime === "image/jpeg" && buffer[0] === 255 && buffer[1] === 216) {
    for (let offset = 2; offset + 9 < buffer.length; ) {
      if (buffer[offset] !== 255) break;
      const marker = buffer[offset + 1],
        length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (!width || !height || width > 4096 || height > 4096)
    throw new StudioError(
      "UPLOAD",
      "Use a valid PNG or JPEG with dimensions up to 4096 × 4096",
    );
  if (decoders>=2) throw new StudioError("RATE_LIMIT","Too many image validations; try again shortly",429);
  decoders++;
  try {await new Promise<void>((resolve, reject) => {
    const child = execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864", "-err_detect", "explode", "-f", "image2pipe", "-vcodec", mime === "image/png" ? "png" : "mjpeg", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 5000, maxBuffer: 10_000 }, (error) => {
      if (error) reject(new StudioError("UPLOAD", "Upload a complete, decodable PNG or JPEG"));
      else resolve();
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(buffer);
  });} finally {decoders--;}
}

export async function registerAsset(
  owner: string,
  projectId: string,
  mime: string,
  buffer: Buffer,
  client?: PoolClient,
) {
  const production=process.env.VIDIO_MODE === "production";
  const limit=mime.startsWith("image/") ? 5_000_000 : production ? MAX_ASSET_BYTES : 6_000_000;
  if (!["image/png","image/jpeg","video/mp4","audio/mpeg","text/vtt"].includes(mime) || !buffer.length || buffer.length>limit || (mime==="text/vtt" && buffer.length>100_000))
    throw new StudioError("ASSET_LIMIT", "Unsupported asset type or size",413);
  const id = randomUUID();
  if (writes >= 2) throw new StudioError("RATE_LIMIT", "Too many media writes; try again shortly", 429);
  writes++;
  async function insert(connection: PoolClient) {
    if (!(await connection.query("SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2",[projectId,owner])).rows.length)
      throw new StudioError("NOT_FOUND","Project not found",404);
    await transaction(async (reservation) => {
      await reservation.query("SELECT pg_advisory_xact_lock(4112027)");
      const usage = await reservation.query(
        "WITH reserved AS (SELECT id,owner_id,project_id,size FROM vidio_assets UNION SELECT id,owner_id,project_id,size FROM vidio_asset_intents) SELECT coalesce(sum(size),0)::bigint AS total, coalesce(sum(size) FILTER (WHERE owner_id=$1),0)::bigint AS owned, count(*) FILTER (WHERE project_id=$2)::int AS n FROM reserved",
        [owner, projectId],
      );
      if (Number(usage.rows[0].total)+buffer.length>(production ? 100_000_000_000 : 150_000_000) || Number(usage.rows[0].owned)+buffer.length>(production ? 1_000_000_000 : 50_000_000) || usage.rows[0].n>=64)
        throw new StudioError("LIMIT", "Media storage limit reached", 429);
      await reservation.query("INSERT INTO vidio_asset_intents(id,owner_id,project_id,size,storage_backend) VALUES($1,$2,$3,$4,$5)",[id,owner,projectId,buffer.length,production ? "s3" : "local"]);
    });
    const key=objectKey(projectId,id);
    if (production) await productionObjectStore().put(key,mime,buffer);
    else {
      await mkdir(assetsDirectory(), { recursive: true, mode: 0o700 });
      await writeFile(assetPath(id), buffer, { mode: 0o600, flag: "wx" });
    }
    await connection.query(
      "INSERT INTO vidio_assets(id,owner_id,project_id,mime,size,storage_backend,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, owner, projectId, mime, buffer.length,production?"s3":"local",production?key:null],
    );
    return id;
  }
  try { return await (client ? insert(client) : transaction(insert)); }
  finally { writes--; }
}

export async function cleanupAssets() {
  await transaction(async (client) => {
    if (!(await client.query("SELECT pg_try_advisory_xact_lock(4112031) AS locked")).rows[0].locked) return;
    const pending=await client.query("SELECT i.* FROM vidio_asset_intents i WHERE i.created_at<now()-interval '2 hours' AND i.storage_backend=$1 AND NOT EXISTS(SELECT 1 FROM vidio_assets a WHERE a.id=i.id) ORDER BY i.created_at LIMIT 20 FOR UPDATE OF i",[process.env.VIDIO_MODE === "production" ? "s3" : "local"]);
    for (const row of pending.rows) {
      try {
        if (row.storage_backend === "s3") await productionObjectStore().remove(objectKey(row.project_id,row.id));
        else await rm(assetPath(row.id),{force:true});
        await client.query("DELETE FROM vidio_asset_intents WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM vidio_assets WHERE id=$1)",[row.id]);
      } catch { /* Retain the reservation until deletion can be proven. */ }
    }
    await client.query("DELETE FROM vidio_request_limits WHERE window_at<now()-interval '2 days'");
  });
}

export async function readAsset(owner: string, id: string) {
  z.uuid().parse(id);
  const result = await database().query(
    "SELECT mime,size,storage_backend,project_id FROM vidio_assets WHERE id=$1 AND owner_id=$2",
    [id, owner],
  );
  if (!result.rows.length)
    throw new StudioError("NOT_FOUND", "Media not found", 404);
  const row=result.rows[0];
  const buffer=row.storage_backend === "s3" ? await productionObjectStore().get(objectKey(row.project_id,id)) : await readFile(assetPath(id));
  if (buffer.length !== Number(row.size)) throw new StudioError("STORAGE","Asset size verification failed",503);
  return {
    buffer,
    mime: String(result.rows[0].mime),
    size: Number(result.rows[0].size),
  };
}
export async function signedAssetUrl(owner:string,id:string) {
  z.uuid().parse(id);
  const result=await database().query("SELECT project_id,storage_backend FROM vidio_assets WHERE id=$1 AND owner_id=$2",[id,owner]);
  if (!result.rows.length) throw new StudioError("NOT_FOUND","Asset not found",404);
  if (result.rows[0].storage_backend !== "s3") throw new StudioError("STORAGE_CONFIGURATION","Live providers require private object storage",503);
  return productionObjectStore().signedUrl(objectKey(result.rows[0].project_id,id));
}

export async function mediaToken(owner: string, id: string) {
  return new SignJWT({ assetId: z.uuid().parse(id) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(owner)
    .setIssuer("vidio-preview")
    .setAudience("vidio-media")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey());
}
export async function verifyMediaToken(token: string, id: string) {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: "vidio-preview",
      audience: "vidio-media",
      algorithms: ["HS256"],
    });
    if (payload.sub && payload.assetId === id) return payload.sub;
  } catch {
    /* A token never grants arbitrary file access. */
  }
  throw new StudioError("AUTH", "Media link expired or invalid", 401);
}
export async function projectMedia(owner: string, project: StudioProject) {
  const ids = [
    project.imageAssetId,
    ...(project.imageAssetIds ?? []),
    project.captionAssetId,
    project.voiceAssetId,
    project.finalAssetId,
    ...project.segments.map((segment) => segment.assetId),
  ].filter((id): id is string => Boolean(id));
  return Object.fromEntries(
    await Promise.all(
      [...new Set(ids)].map(async (id) => [
        id,
        `${publicOrigin()}/api/media/${id}?token=${await mediaToken(owner, id)}`,
      ]),
    ),
  );
}
