import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, GetPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { StudioError } from "./types";

export const MAX_ASSET_BYTES = 100_000_000;
export class PrivateObjectStore {
  constructor(private client: S3Client, private bucket: string) {}
  async verifyPrivate() {
    try {
      const result = await this.client.send(new GetPublicAccessBlockCommand({Bucket:this.bucket}), {abortSignal:AbortSignal.timeout(10_000)});
      const block=result.PublicAccessBlockConfiguration;
      if (!block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets)
        throw new Error("Bucket is not private");
    } catch {
      throw new StudioError("STORAGE_CONFIGURATION", "Storage requires all four bucket Block Public Access settings and permission to verify them", 503);
    }
  }
  async put(key:string, mime:string, buffer:Buffer) {
    await this.verifyPrivate();
    try {
      await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:buffer,ContentType:mime,CacheControl:"private, no-store"}), {abortSignal:AbortSignal.timeout(30_000)});
    } catch { throw new StudioError("STORAGE","Private asset upload failed",503); }
  }
  async get(key:string) {
    await this.verifyPrivate();
    try {
      const result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}), {abortSignal:AbortSignal.timeout(30_000)});
      if (!result.Body || Number(result.ContentLength)>MAX_ASSET_BYTES) throw new Error("Asset size");
      const chunks: Buffer[]=[];
      let size=0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size+=chunk.length;
        if (size>MAX_ASSET_BYTES) throw new Error("Asset size");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch { throw new StudioError("STORAGE","Private asset retrieval failed",503); }
  }
  async signedUrl(key:string) {
    await this.verifyPrivate();
    return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:key}),{expiresIn:600});
  }
  async remove(key:string) {
    await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key}), {abortSignal:AbortSignal.timeout(10_000)});
  }
}
export function objectKey(projectId:string, assetId:string) {
  return `studio/${z.uuid().parse(projectId)}/${z.uuid().parse(assetId)}`;
}
export function productionObjectStore() {
  const bucket=process.env.S3_BUCKET_NAME;
  const region=process.env.S3_REGION;
  if (!bucket || !region) throw new StudioError("STORAGE_CONFIGURATION","Configure S3_BUCKET_NAME and S3_REGION",503);
  const endpoint=process.env.S3_ENDPOINT_URL;
  if (Boolean(process.env.S3_ACCESS_KEY_ID)!==Boolean(process.env.S3_SECRET_ACCESS_KEY))
    throw new StudioError("STORAGE_CONFIGURATION","Configure both S3 credential variables or use the server IAM role",503);
  if (endpoint && (new URL(endpoint).protocol !== "https:" || new URL(endpoint).username || new URL(endpoint).password))
    throw new StudioError("STORAGE_CONFIGURATION","Storage endpoint must use HTTPS",503);
  const credentials=process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? {accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY} : undefined;
  const client=new S3Client({region,endpoint,credentials,maxAttempts:2,requestHandler:{connectionTimeout:5000,requestTimeout:30000}});
  return new PrivateObjectStore(client,bucket);
}
