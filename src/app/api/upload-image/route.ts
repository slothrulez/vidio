import { NextRequest, NextResponse } from 'next/server';
import { S3Storage } from 'coze-coding-dev-sdk';
import { safeLogError } from '@/lib/log-redact';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: '未找到上传文件' }, { status: 400 });
    }

    // 将 File 转换为 Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 初始化存储客户端
    const storage = new S3Storage({
      endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
      accessKey: '',
      secretKey: '',
      bucketName: process.env.COZE_BUCKET_NAME,
      region: 'cn-beijing',
    });

    // 上传文件
    const fileName = `product-images/${Date.now()}_${file.name}`;
    const fileKey = await storage.uploadFile({
      fileContent: buffer,
      fileName,
      contentType: file.type || 'image/jpeg',
    });

    // 生成可访问的 URL
    const imageUrl = await storage.generatePresignedUrl({
      key: fileKey,
      expireTime: 86400 * 7, // 7 天有效期
    });

    return NextResponse.json({
      success: true,
      imageUrl,
      fileKey,
    });
  } catch (error) {
    console.error('图片上传失败:', safeLogError(error));
    return NextResponse.json(
      { error: '图片上传失败，请重试' },
      { status: 500 }
    );
  }
}
