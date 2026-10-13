import { NextRequest, NextResponse } from 'next/server';
import { safeLogError } from '@/lib/log-redact';

export async function GET(request: NextRequest) {
  const videoUrl = request.nextUrl.searchParams.get('url');
  const filename = request.nextUrl.searchParams.get('filename') || 'video.mp4';
  
  if (!videoUrl) {
    return NextResponse.json({ error: 'Missing video URL' }, { status: 400 });
  }
  
  try {
    // Fetch the video from the remote URL
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      return NextResponse.json({ 
        error: `Video fetch failed: ${response.status}`
      }, { status: response.status });
    }
    
    // Get the video content as array buffer
    const arrayBuffer = await response.arrayBuffer();
    
    // Return the video with proper headers for download
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': arrayBuffer.byteLength.toString(),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Video download failed:', safeLogError(error));
    return NextResponse.json({ 
      error: 'Video download failed'
    }, { status: 500 });
  }
}
