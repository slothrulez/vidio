import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve a local file
 * GET /api/file?path=/tmp/xxx/video/xxx.mp4
 */
export async function GET(request: NextRequest) {
  try {
    const filePath = request.nextUrl.searchParams.get('path');
    
    if (!filePath) {
      return NextResponse.json({ error: 'Missing file path parameter' }, { status: 400 });
    }
    
    // Security: only files under /tmp
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith('/tmp/')) {
      return NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
    }
    
    // Existence check
    if (!fs.existsSync(normalizedPath)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    
    // Read the file
    const fileBuffer = fs.readFileSync(normalizedPath);
    
    // Content-Type from the extension
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
    console.error('File access error:', safeLogError(error));
    return NextResponse.json({ error: 'File access failed' }, { status: 500 });
  }
}
