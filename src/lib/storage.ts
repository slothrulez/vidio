import { S3Storage } from "coze-coding-dev-sdk";

// 初始化对象存储客户端
const storage = new S3Storage({
  endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
  accessKey: "",
  secretKey: "",
  bucketName: process.env.COZE_BUCKET_NAME,
  region: "cn-beijing",
});

/**
 * 从远程 URL 下载文件并上传到对象存储
 * @param url 远程文件 URL
 * @param fileName 目标文件名
 * @param contentType 文件类型
 * @param timeout 下载超时时间（毫秒）
 * @returns 上传后的文件 key 和签名 URL
 */
export async function uploadFromRemoteUrl(
  url: string,
  fileName: string,
  contentType?: string,
  timeout?: number
): Promise<{ key: string; signedUrl: string }> {
  // 从远程 URL 下载并上传
  const key = await storage.uploadFromUrl({
    url,
    timeout: timeout || 60000, // 默认60秒超时
  });

  // 生成签名 URL（有效期24小时）
  const signedUrl = await storage.generatePresignedUrl({
    key,
    expireTime: 86400,
  });

  return { key, signedUrl };
}

/**
 * 上传本地文件到对象存储
 * @param fileContent 文件内容（Buffer）
 * @param fileName 目标文件名
 * @param contentType 文件类型
 * @returns 上传后的文件 key 和签名 URL
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
 * 生成文件的签名 URL
 * @param key 文件 key
 * @param expireTime 有效期（秒）
 * @returns 签名 URL
 */
export async function getSignedUrl(key: string, expireTime: number = 86400): Promise<string> {
  return await storage.generatePresignedUrl({
    key,
    expireTime,
  });
}

/**
 * 读取文件内容
 * @param key 文件 key
 * @returns 文件内容（Buffer）
 */
export async function readFile(key: string): Promise<Buffer> {
  return await storage.readFile({ fileKey: key });
}

/**
 * 删除文件
 * @param key 文件 key
 * @returns 是否删除成功
 */
export async function deleteFile(key: string): Promise<boolean> {
  return await storage.deleteFile({ fileKey: key });
}

/**
 * 检查文件是否存在
 * @param key 文件 key
 * @returns 是否存在
 */
export async function fileExists(key: string): Promise<boolean> {
  return await storage.fileExists({ fileKey: key });
}

export { storage };