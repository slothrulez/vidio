import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 代理访问本地文件
 * GET /api/file?path=/tmp/xxx/video/xxx.mp4
 */
export async function GET(request: NextRequest) {
  try {
    const filePath = request.nextUrl.searchParams.get('path');
    
    if (!filePath) {
      return NextResponse.json({ error: '缺少文件路径参数' }, { status: 400 });
    }
    
    // 安全检查：只允许访问 /tmp 目录下的文件
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith('/tmp/')) {
      return NextResponse.json({ error: '无权访问该路径' }, { status: 403 });
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(normalizedPath)) {
      return NextResponse.json({ error: '文件不存在' }, { status: 404 });
    }
    
    // 读取文件
    const fileBuffer = fs.readFileSync(normalizedPath);
    
    // 根据文件扩展名确定 Content-Type
    const ext = path.extname(normalizedPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.webm': 'video/webm',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length.toString(),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('文件访问错误:', safeLogError(error));
    return NextResponse.json({ error: '文件访问失败' }, { status: 500 });
  }
}
