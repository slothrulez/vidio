import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { redactUrl, redactText } from '@/lib/log-redact';

/**
 * Video proxy API - works around browser access restrictions on provider video URLs
 * The frontend fetches videos through this proxy to avoid 403s
 */
export async function GET(request: NextRequest) {
  const videoUrl = request.nextUrl.searchParams.get('url');
  
  if (!videoUrl) {
    return NextResponse.json({ error: 'Missing video URL parameter' }, { status: 400 });
  }

  try {
    console.log('[Video Proxy] proxying:', redactUrl(videoUrl));
    
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'identity', // no compression
      },
    });

    // Content-Type
    const contentType = response.headers['content-type'] || 'video/mp4';
    const contentLength = Buffer.byteLength(response.data);
    
    console.log('[Video Proxy] fetched, size:', contentLength, 'bytes');
    
    return new NextResponse(response.data, {
      status: 200,
      headers: {
        'Content-Type': contentType as string,
        'Content-Length': contentLength.toString(),
        'Cache-Control': 'public, max-age=3600', // cache for 1 hour
        'Access-Control-Allow-Origin': '*', // allow cross-origin
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Video Proxy] fetch failed:', redactText(errorMessage));
    
    return NextResponse.json(
      { error: 'Video fetch failed', detail: errorMessage },
      { status: 500 }
    );
  }
}