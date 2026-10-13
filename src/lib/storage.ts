import { S3Storage } from "coze-coding-dev-sdk";

// Object storage client
const storage = new S3Storage({
  endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
  accessKey: "",
  secretKey: "",
  bucketName: process.env.COZE_BUCKET_NAME,
  region: "cn-beijing",
});

/**
 * Download a remote URL and upload it to object storage
 * @param url remote file URL
 * @param fileName target file name
 * @param contentType content type
 * @param timeout download timeout in ms
 * @returns the stored key and a signed URL
 */
export async function uploadFromRemoteUrl(
  url: string,
  fileName: string,
  contentType?: string,
  timeout?: number
): Promise<{ key: string; signedUrl: string }> {
  // Download and upload
  const key = await storage.uploadFromUrl({
    url,
    timeout: timeout || 60000, // default 60s timeout
  });

  // Signed URL valid for 24 hours
  const signedUrl = await storage.generatePresignedUrl({
    key,
    expireTime: 86400,
  });

  return { key, signedUrl };
}

/**
 * Upload a local file to object storage
 * @param fileContent file content (Buffer)
 * @param fileName target file name
 * @param contentType content type
 * @returns the stored key and a signed URL
 */
export async function uploadLocalFile(
  fileContent: Buffer,
  fileName: string,
  contentType: string
): Promise<{ key: string; signedUrl: string }> {
  const key = await storage.uploadFile({
    fileContent,
    fileName,
    contentType,
  });

  const signedUrl = await storage.generatePresignedUrl({
    key,
    expireTime: 86400,
  });

  return { key, signedUrl };
}

/**
 * Create a signed URL for a file
 * @param key file key
 * @param expireTime validity in seconds
 * @returns signed URL
 */
export async function getSignedUrl(key: string, expireTime: number = 86400): Promise<string> {
  return await storage.generatePresignedUrl({
    key,
    expireTime,
  });
}

/**
 * Read a file
 * @param key file key
 * @returns file content (Buffer)
 */
export async function readFile(key: string): Promise<Buffer> {
  return await storage.readFile({ fileKey: key });
}

/**
 * Delete a file
 * @param key file key
 * @returns whether the delete succeeded
 */
export async function deleteFile(key: string): Promise<boolean> {
  return await storage.deleteFile({ fileKey: key });
}

/**
 * Check whether a file exists
 * @param key file key
 * @returns whether it exists
 */
export async function fileExists(key: string): Promise<boolean> {
  return await storage.fileExists({ fileKey: key });
}

export { storage };