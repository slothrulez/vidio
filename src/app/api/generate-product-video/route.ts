import { NextRequest, NextResponse } from 'next/server';
import {
  uploadAndIdentifyProduct,
  generateScripts,
  generateVideoSegments,
  composeFinalVideo,
} from '@/agent/tools';

/**
 * 外部API：一键生成商品带货视频
 * 
 * POST /api/generate-product-video
 * 
 * Request Body:
 * {
 *   imageUrl: string;          // 商品图片URL（必填）
 *   language?: 'chinese' | 'english';  // 配音语言（可选，默认chinese）
 *   productName?: string;      // 商品名称（可选，自动识别）
 *   callbackUrl?: string;      // 回调URL（可选，完成后通知）
 * }
 * 
 * Response:
 * {
 *   success: boolean;
 *   data?: {
 *     sessionId: string;
 *     productName: string;
 *     features: string[];
 *     finalVideoUrl: string;
 *     segments: Array<{ id: number; videoUrl: string; script: string }>;
 *   };
 *   error?: string;
 * }
 */

// 生成唯一的会话ID
function generateSessionId(): string {
  return `api_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// 发送回调通知
async function sendCallback(callbackUrl: string, data: any): Promise<void> {
  if (!callbackUrl) return;
  
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    
    if (!response.ok) {
      console.error(`[API] 回调通知失败: ${response.status}`);
    } else {
      console.log('[API] 回调通知发送成功');
    }
  } catch (error) {
    console.error('[API] 回调通知发送失败:', error);
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const sessionId = generateSessionId();
  
  console.log(`[API] 开始处理外部API请求: sessionId=${sessionId}`);
  
  try {
    // 解析请求体
    const body = await request.json();
    const { imageUrl, language = 'chinese', productName, callbackUrl } = body;
    
    // 验证必填参数
    if (!imageUrl) {
      return NextResponse.json(
        { success: false, error: '缺少必填参数: imageUrl' },
        { status: 400 }
      );
    }
    
    // 验证imageUrl格式
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return NextResponse.json(
        { success: false, error: 'imageUrl必须是有效的HTTP/HTTPS URL' },
        { status: 400 }
      );
    }
    
    console.log(`[API] 参数: imageUrl=${imageUrl}, language=${language}, productName=${productName}`);
    
    // Step 1: 商品识别
    console.log('[API] Step 1: 商品识别...');
    const identifyResult = await uploadAndIdentifyProduct(imageUrl, productName);
    
    if (!identifyResult.success) {
      return NextResponse.json(
        { success: false, error: `商品识别失败: ${identifyResult.error || identifyResult.message}` },
        { status: 500 }
      );
    }
    
    const identifiedProductName = identifyResult.data?.productName as string;
    const features = identifyResult.data?.features as string[] || [];
    const productImageUrl = identifyResult.data?.imageUrl as string;
    
    console.log(`[API] 商品识别成功: productName=${identifiedProductName}, features=${features.length}个`);
    
    // Step 2: 文案生成
    console.log('[API] Step 2: 文案生成...');
    const scriptsResult = await generateScripts(identifiedProductName, features, productImageUrl, language);
    
    if (!scriptsResult.success) {
      return NextResponse.json(
        { success: false, error: `文案生成失败: ${scriptsResult.error || scriptsResult.message}` },
        { status: 500 }
      );
    }
    
    const scripts = scriptsResult.data?.scripts as Array<{ id: number; script: string; prompt: string }>;
    
    if (!scripts || scripts.length === 0) {
      return NextResponse.json(
        { success: false, error: '文案生成返回空结果' },
        { status: 500 }
      );
    }
    
    console.log(`[API] 文案生成成功: ${scripts.length}个分镜`);
    
    // Step 3: 分段视频生成
    console.log('[API] Step 3: 分段视频生成...');
    
    // 构造segments输入
    const segmentsInput = scripts.map(s => ({
      id: s.id,
      script: s.script,
      prompt: s.prompt,
    }));
    
    const videoResult = await generateVideoSegments(
      segmentsInput,
      productImageUrl,
      identifiedProductName
    );
    
    if (!videoResult.success) {
      return NextResponse.json(
        { success: false, error: `分段视频生成失败: ${videoResult.error || videoResult.message}` },
        { status: 500 }
      );
    }
    
    const segments = videoResult.data?.segments as Array<{
      id: number;
      script: string;
      prompt?: string;
      videoUrl?: string;
      audioUrl?: string;
    }>;
    
    if (!segments || segments.length === 0) {
      return NextResponse.json(
        { success: false, error: '分段视频生成返回空结果' },
        { status: 500 }
      );
    }
    
    console.log(`[API] 分段视频生成成功: ${segments.length}个片段`);
    
    // Step 4: 合成最终视频
    console.log('[API] Step 4: 合成最终视频...');
    
    // 过滤出有videoUrl的片段
    const validSegments = segments.filter(s => s.videoUrl);
    
    if (validSegments.length === 0) {
      return NextResponse.json(
        { success: false, error: '没有有效的分段视频可以合成' },
        { status: 500 }
      );
    }
    
    const composeResult = await composeFinalVideo(validSegments, identifiedProductName, { embedSubtitle: false });
    
    if (!composeResult.success) {
      return NextResponse.json(
        { success: false, error: `视频合成失败: ${composeResult.error || composeResult.message}` },
        { status: 500 }
      );
    }
    
    const finalVideoUrl = composeResult.data?.finalVideoUrl as string;
    
    if (!finalVideoUrl) {
      return NextResponse.json(
        { success: false, error: '视频合成返回空URL' },
        { status: 500 }
      );
    }
    
    console.log(`[API] 视频合成成功: finalVideoUrl=${finalVideoUrl}`);
    
    // 计算总耗时
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`[API] 全流程完成: 总耗时=${totalTime}秒`);
    
    // 构造返回数据
    const responseData = {
      sessionId,
      productName: identifiedProductName,
      features,
      finalVideoUrl,
      segments: segments.map(s => ({
        id: s.id,
        videoUrl: s.videoUrl,
        script: s.script,
      })),
      scripts: scripts.map(s => ({
        id: s.id,
        script: s.script,
        prompt: s.prompt,
      })),
      totalTimeSeconds: totalTime,
    };
    
    // 发送回调通知（如果提供了callbackUrl）
    if (callbackUrl) {
      await sendCallback(callbackUrl, {
        success: true,
        data: responseData,
      });
    }
    
    return NextResponse.json({
      success: true,
      data: responseData,
    });
    
  } catch (error: any) {
    console.error('[API] 处理请求失败:', error);
    
    const errorResponse = {
      success: false,
      error: error.message || '未知错误',
      sessionId,
    };
    
    // 发送错误回调通知
    const body = await request.json().catch(() => ({}));
    if (body.callbackUrl) {
      await sendCallback(body.callbackUrl, errorResponse);
    }
    
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

// GET: 获取API使用说明
export async function GET() {
  return NextResponse.json({
    name: 'vidio - 商品带货视频生成API',
    version: '1.0.0',
    description: '一键生成商品带货视频的自动化API',
    endpoint: '/api/generate-product-video',
    method: 'POST',
    request: {
      imageUrl: {
        type: 'string',
        required: true,
        description: '商品图片URL（HTTP/HTTPS）',
      },
      language: {
        type: 'string',
        required: false,
        default: 'chinese',
        enum: ['chinese', 'english'],
        description: '配音语言',
      },
      productName: {
        type: 'string',
        required: false,
        description: '商品名称（如不提供则自动识别）',
      },
      callbackUrl: {
        type: 'string',
        required: false,
        description: '回调URL，完成后通知结果',
      },
    },
    response: {
      success: {
        type: 'boolean',
        description: '是否成功',
      },
      data: {
        sessionId: 'string - 会话ID',
        productName: 'string - 商品名称',
        features: 'string[] - 商品卖点',
        finalVideoUrl: 'string - 最终视频URL',
        segments: 'array - 分段视频列表',
        totalTimeSeconds: 'number - 总耗时（秒）',
      },
      error: {
        type: 'string',
        description: '错误信息（仅在失败时返回）',
      },
    },
    example: {
      request: {
        imageUrl: 'https://example.com/product.jpg',
        language: 'chinese',
      },
      response: {
        success: true,
        data: {
          sessionId: 'api_1234567890',
          productName: '高景观婴儿推车',
          features: ['可调节遮阳篷', '大容量储物空间'],
          finalVideoUrl: 'https://xxx.com/final.mp4',
          segments: [
            { id: 1, videoUrl: 'https://xxx.com/segment1.mp4', script: '...' },
          ],
          totalTimeSeconds: 180,
        },
      },
    },
  });
}