import { NextRequest, NextResponse } from 'next/server';
import { S3Storage } from 'coze-coding-dev-sdk';
import { safeLogError } from '@/lib/log-redact';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Storage client
    const storage = new S3Storage({
      endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
      accessKey: '',
      secretKey: '',
      bucketName: process.env.COZE_BUCKET_NAME,
      region: 'cn-beijing',
    });

    // Upload
    const fileName = `product-images/${Date.now()}_${file.name}`;
    const fileKey = await storage.uploadFile({
      fileContent: buffer,
      fileName,
      contentType: file.type || 'image/jpeg',
    });

    // Signed URL
    const imageUrl = await storage.generatePresignedUrl({
      key: fileKey,
      expireTime: 86400 * 7, // valid for 7 days
    });

    return NextResponse.json({
      success: true,
      imageUrl,
      fileKey,
    });
  } catch (error) {
    console.error('Image upload failed:', safeLogError(error));
    return NextResponse.json(
      { error: 'Image upload failed, please retry' },
      { status: 500 }
    );
  }
}
