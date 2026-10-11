import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { redactUrl, redactText } from '@/lib/log-redact';

/**
 * 视频代理 API - 解决火山引擎视频 URL 的浏览器访问限制
 * 前端通过此 API 代理访问视频，绕过 403 错误
 */
export async function GET(request: NextRequest) {
  const videoUrl = request.nextUrl.searchParams.get('url');
  
  if (!videoUrl) {
    return NextResponse.json({ error: '缺少视频URL参数' }, { status: 400 });
  }

  try {
    console.log('[Video Proxy] 代理视频:', redactUrl(videoUrl));
    
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'identity', // 不压缩，保持原始内容
      },
    });

    // 获取 Content-Type
    const contentType = response.headers['content-type'] || 'video/mp4';
    const contentLength = Buffer.byteLength(response.data);
    
    console.log('[Video Proxy] 视频获取成功, 大小:', contentLength, 'bytes');
    
    return new NextResponse(response.data, {
      status: 200,
      headers: {
        'Content-Type': contentType as string,
        'Content-Length': contentLength.toString(),
        'Cache-Control': 'public, max-age=3600', // 缓存1小时
        'Access-Control-Allow-Origin': '*', // 允许跨域
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    console.error('[Video Proxy] 视频获取失败:', redactText(errorMessage));
    
    return NextResponse.json(
      { error: '视频获取失败', detail: errorMessage },
      { status: 500 }
    );
  }
}