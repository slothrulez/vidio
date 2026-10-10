import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { database } from "./db";
import { transaction } from "./db";
import type { PoolClient } from "pg";
import { signingKey, publicOrigin } from "./config";
import { StudioError, type StudioProject } from "./types";

export const assetsDirectory = () =>
  path.join(process.cwd(), ".vidio", "assets");
export function assetPath(id: string) {
  return path.join(assetsDirectory(), z.uuid().parse(id));
}

export function validateImage(buffer: Buffer, mime: string) {
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
}

export async function registerAsset(
  owner: string,
  projectId: string,
  mime: string,
  buffer: Buffer,
  client?: PoolClient,
) {
  if (!buffer.length || buffer.length > 6_000_000)
    throw new StudioError("ASSET_LIMIT", "Demo media is too large");
  const id = randomUUID();
  async function insert(connection: PoolClient) {
    await connection.query("SELECT pg_advisory_xact_lock(4112027)");
    const usage = await connection.query(
      "SELECT coalesce(sum(size),0)::bigint AS total, coalesce(sum(size) FILTER (WHERE owner_id=$1),0)::bigint AS owned, count(*) FILTER (WHERE project_id=$2)::int AS n FROM vidio_assets",
      [owner, projectId],
    );
    if (
      Number(usage.rows[0].total) + buffer.length > 150_000_000 ||
      Number(usage.rows[0].owned) + buffer.length > 50_000_000 ||
      usage.rows[0].n >= 64
    )
      throw new StudioError("LIMIT", "Preview media limit reached", 429);
    await mkdir(assetsDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(assetPath(id), buffer, { mode: 0o600, flag: "wx" });
    await connection.query(
      "INSERT INTO vidio_assets(id,owner_id,project_id,mime,size) VALUES($1,$2,$3,$4,$5)",
      [id, owner, projectId, mime, buffer.length],
    );
    return id;
  }
  return client ? insert(client) : transaction(insert);
}

export async function readAsset(owner: string, id: string) {
  const result = await database().query(
    "SELECT mime,size FROM vidio_assets WHERE id=$1 AND owner_id=$2",
    [id, owner],
  );
  if (!result.rows.length)
    throw new StudioError("NOT_FOUND", "Media not found", 404);
  return {
    buffer: await readFile(assetPath(id)),
    mime: String(result.rows[0].mime),
    size: Number(result.rows[0].size),
  };
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
