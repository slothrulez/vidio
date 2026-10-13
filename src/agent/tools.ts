/**
 * Agent 工具函数 - HTTP 请求调度
 * 只做 HTTP 请求调用现有 API，不内置业务逻辑
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { uploadFromRemoteUrl, uploadLocalFile } from '../lib/storage';
import { parseRegenerationResult } from './transport';
import { redactUrl, safeLogError } from '@/lib/log-redact';

const getBaseUrl = () => {
  const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT;
  if (domain) {
    // 如果已经包含协议，直接使用
    if (domain.startsWith('http://') || domain.startsWith('https://')) {
      return domain;
    }
    // 否则添加 https 前缀
    return `https://${domain}`;
  }
  return 'http://localhost:5000';
};
const BASE_URL = getBaseUrl();

// 本地视频存储目录
const getVideoStorageDir = (subDir: string) => {
  const env = process.env.COZE_PROJECT_ENV;
  const baseDir = env === 'PROD' ? '/tmp' : (process.env.COZE_WORKSPACE_PATH || '/workspace/projects');
  const videoDir = path.join(baseDir, 'public', 'videos', subDir);
  
  // 确保目录存在
  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }
  return videoDir;
};

// 下载视频到本地（优先转存到对象存储）
async function downloadVideoToLocal(
  videoUrl: string, 
  subDir: string, 
  filename: string,
  retries: number = 3
): Promise<{ localPath: string | null; signedUrl: string | null }> {
  let signedUrl: string | null = null;
  let localPath: string | null = null;
  
  // 优先尝试转存到对象存储（生成可访问的签名 URL）
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Tool] 尝试转存视频到对象存储 (尝试 ${attempt}/${retries}): ${redactUrl(videoUrl)}`);
      
      const result = await uploadFromRemoteUrl(
        videoUrl,
        `${subDir}/${filename}`,
        'video/mp4',
        60000 // 60秒超时
      );
      
      signedUrl = result.signedUrl;
      console.log(`[Tool] 视频已转存到对象存储，签名URL: ${redactUrl(signedUrl)}`);
      break;
    } catch (error) {
      console.error(`[Tool] 转存视频到对象存储失败 (尝试 ${attempt}):`, safeLogError(error));
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  
  // 备用方案：下载到本地存储
  if (!signedUrl) {
    const videoDir = getVideoStorageDir(subDir);
    const filePath = path.join(videoDir, filename);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[Tool] 下载视频到本地存储 (尝试 ${attempt}/${retries}): ${redactUrl(videoUrl)}`);
        
        const response = await axios.get(videoUrl, {
          responseType: 'arraybuffer',
          timeout: 60000 // 60秒超时
        });
        
        fs.writeFileSync(filePath, Buffer.from(response.data));
        localPath = `/videos/${subDir}/${filename}`;
        console.log(`[Tool] 视频已保存到本地: [path]`);
        break;
      } catch (error) {
        console.error(`[Tool] 下载视频到本地失败 (尝试 ${attempt}):`, safeLogError(error));
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
  }
  
  if (!signedUrl && !localPath) {
    console.error(`[Tool] 下载视频最终失败: ${redactUrl(videoUrl)}`);
  }
  
  return { localPath, signedUrl };
}

// 工具结果类型
export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

// 会话状态类型
export interface SessionState {
  productImageUrl?: string;
  productName?: string;
  features?: string[];
  scripts?: Array<{ id: number; script: string; prompt?: string }>;
  segments?: Array<{ 
    id: number; 
    script: string; 
    prompt?: string;
    videoPath?: string; 
    audioPath?: string;
    videoUrl?: string;
    audioUrl?: string;
    localVideoPath?: string; // 本地视频路径（用于播放）
  }>;
  finalVideoUrl?: string;
  localVideoPath?: string; // 本地最终视频路径
  finalVideoLocalPath?: string;
  sessionId?: string; // 会话ID（用于视频文件夹命名）
  currentStage?: string;
}

/**
 * 1. 上传图片并识别商品（支持多图片：主图片 + 辅助图片）
 * 调用 /api/identify-product
 * @param imageUrl 主图片URL（重点参考）
 * @param auxiliaryImages 辅助图片URL列表（补充参考）
 * @param _productName 商品名称（可选）
 * @param customHeaders 自定义请求头
 */
export async function uploadAndIdentifyProduct(
  imageUrl: string,
  auxiliaryImages?: string[],
  _productName?: string,
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] 调用 /api/identify-product，主图片:', redactUrl(imageUrl));
  if (auxiliaryImages && auxiliaryImages.length > 0) {
    console.log('[Tool] 辅助图片:', `${auxiliaryImages.length} image(s)`);
  }
  
  try {
    // 如果 imageUrl 是远程 URL，需要先下载再上传
    const formData = new FormData();
    
    if (imageUrl.startsWith('http')) {
      // 下载图片（添加超时和重试机制）
      let imageBuffer: Buffer | null = null;
      const maxRetries = 3;
      
      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          const imageResponse = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            headers: customHeaders,
            timeout: 15000 // 15秒超时
          });
          imageBuffer = Buffer.from(imageResponse.data);
          break; // 成功则退出重试循环
        } catch (retryError: unknown) {
          if (axios.isAxiosError(retryError) && (retryError.code === 'ETIMEDOUT' || retryError.code === 'ECONNABORTED')) {
            console.warn(`[Tool] 图片下载超时，重试 ${retry + 1}/${maxRetries}`);
            if (retry < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒后重试
              continue;
            }
          }
          throw retryError; // 其他错误或最后一次重试失败，抛出异常
        }
      }
      
      if (!imageBuffer) {
        throw new Error('图片下载失败，请检查图片URL是否可访问');
      }
      
      const imageFile = new File([new Uint8Array(imageBuffer)], 'product.jpg', { type: 'image/jpeg' });
      formData.append('image', imageFile); // 主图片
      formData.append('isMainImage', 'true'); // 标记为主图片
      
      // 下载并上传辅助图片
      if (auxiliaryImages && auxiliaryImages.length > 0) {
        for (let i = 0; i < auxiliaryImages.length; i++) {
          const auxUrl = auxiliaryImages[i];
          if (auxUrl.startsWith('http')) {
            try {
              const auxResponse = await axios.get(auxUrl, {
                responseType: 'arraybuffer',
                headers: customHeaders,
                timeout: 15000
              });
              const auxBuffer = Buffer.from(auxResponse.data);
              const auxFile = new File([new Uint8Array(auxBuffer)], `auxiliary_${i}.jpg`, { type: 'image/jpeg' });
              formData.append('auxiliaryImages', auxFile); // 辅助图片
              console.log(`[Tool] 辅助图片${i + 1}已上传: ${redactUrl(auxUrl)}`);
            } catch (auxError) {
              console.warn(`[Tool] 辅助图片${i + 1}下载失败，跳过: ${redactUrl(auxUrl)}`);
            }
          }
        }
      }
    } else {
      // 本地路径，读取文件
      const fs = await import('fs');
      const imageBuffer = fs.readFileSync(imageUrl);
      const imageFile = new File([imageBuffer], 'product.jpg', { type: 'image/jpeg' });
      formData.append('image', imageFile);
    }
    
    const response = await axios.post(
      `${BASE_URL}/api/identify-product`,
      formData,
      { 
        headers: { 
          ...customHeaders,
          'Content-Type': 'multipart/form-data'
        }
      }
    );
    
    const result = response.data;
    return {
      success: true,
      message: `商品识别完成：${result.productName}`,
      data: {
        productName: result.productName,
        productImageUrl: result.imageUrl || imageUrl,
        features: result.suggestedFeatures || result.features || [],
        productType: result.productType,
        currentStage: "product_identified"
      }
    };
  } catch (error) {
    console.error('[Tool] identify-product 失败:', safeLogError(error));
    return {
      success: false,
      message: '商品识别失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

/**
 * 2. 生成带货文案
 * 调用 /api/generate-script
 */
export async function generateScripts(
  productName: string,
  features: string[],
  productImageUrl?: string,
  customHeaders?: Record<string, string>,
  voiceLanguage?: string // 配音语言：mandarin(普通话) 或 english(英语)
): Promise<ToolResult> {
  console.log('[Tool] 调用 /api/generate-script，配音语言:', voiceLanguage || 'mandarin');
  
  try {
    const formData = new FormData();
    formData.append('productName', productName);
    formData.append('productSellingPoints', features.join(','));
    formData.append('voiceLanguage', voiceLanguage || 'mandarin'); // 添加配音语言参数
    
    // 如果有图片，下载并上传
    if (productImageUrl && productImageUrl.startsWith('http')) {
      const imageResponse = await axios.get(productImageUrl, { 
        responseType: 'arraybuffer',
        headers: customHeaders
      });
      const imageBuffer = Buffer.from(imageResponse.data);
      const imageFile = new File([imageBuffer], 'product.jpg', { type: 'image/jpeg' });
      formData.append('productImage', imageFile);
    }
    
    // generate-script 是 SSE 流式接口，我们收集最终结果
    // 注意：发送FormData时不要手动设置Content-Type，axios会自动设置正确的boundary
    const response = await axios.post(
      `${BASE_URL}/api/generate-script`,
      formData,
      { 
        headers: customHeaders,
        responseType: 'text'
      }
    );
    
    // 解析 SSE 响应获取文案和画面Prompt
    const lines = response.data.split('\n');
    const scripts: Array<{ id: number; script: string; prompt: string }> = [];
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'script_segment' && data.content) {
            // 先添加脚本，prompt后续通过prompt_segment更新
            scripts.push({
              id: data.content.id || data.segmentIndex + 1,
              script: data.content.script || data.content,
              prompt: '' // 先留空，等待prompt_segment更新
            });
          } else if (data.type === 'prompt_segment' && data.content) {
            // 更新对应segment的prompt
            const segmentId = data.content.id;
            const existingScript = scripts.find(s => s.id === segmentId);
            if (existingScript) {
              existingScript.prompt = data.content.prompt;
            } else {
              // 如果还没添加script，先添加完整数据
              scripts.push({
                id: segmentId,
                script: data.content.script,
                prompt: data.content.prompt
              });
            }
          } else if (data.type === 'done') {
            // 从 done 事件获取完整数据
            const doneData = JSON.parse(data.content);
            if (doneData.segments && doneData.segments.length > 0) {
              scripts.length = 0; // 清空之前的数据
              for (const seg of doneData.segments) {
                scripts.push({
                  id: seg.id || scripts.length + 1,
                  script: seg.script || '',
                  prompt: seg.prompt || `${productName}产品展示，专业拍摄`
                });
              }
            }
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
    
    // 如果没有解析到，使用默认文案+Prompt（根据语言选择）
    const lang = voiceLanguage || 'mandarin';
    if (scripts.length === 0) {
      if (lang === 'english') {
        scripts.push(
          { id: 1, script: `${productName} is amazing, highly recommended!`, prompt: `${productName} panoramic display, eye-catching` },
          { id: 2, script: `${features[0] || 'Quality'} is excellent, great value!`, prompt: `${productName} close-up details, quality showcase` },
          { id: 3, script: `Fashionable design, stunning appearance!`, prompt: `${productName} exterior display, design aesthetics` },
          { id: 4, script: `Order now, limited time offer!`, prompt: `${productName} purchase guide, promotional atmosphere` }
        );
      } else {
        scripts.push(
          { id: 1, script: `${productName}太棒了，强烈推荐！`, prompt: `${productName}全景展示，吸引眼球` },
          { id: 2, script: `${features[0] || '品质'}过硬，性价比超高`, prompt: `${productName}细节特写，品质展示` },
          { id: 3, script: `设计时尚，颜值爆表`, prompt: `${productName}外观展示，设计美感` },
          { id: 4, script: `现在下单，限时优惠！`, prompt: `${productName}购买引导，促销氛围` }
        );
      }
    }
    
    return {
      success: true,
      message: `文案生成完成，共 ${scripts.length} 段（含画面Prompt）`,
      data: { 
        scripts,
        currentStage: "script_generated"
      }
    };
  } catch (error) {
    console.error('[Tool] generate-script 失败:', safeLogError(error));
    // 降级返回默认文案（根据语言选择）
    const lang = voiceLanguage || 'mandarin';
    const scripts = lang === 'english' ? [
      { id: 1, script: `${productName} is amazing, highly recommended!` },
      { id: 2, script: `Quality is excellent, great value!` },
      { id: 3, script: `Fashionable design, stunning appearance!` },
      { id: 4, script: `Order now, limited time offer!` }
    ] : [
      { id: 1, script: `${productName}太棒了，强烈推荐！` },
      { id: 2, script: `品质过硬，性价比超高` },
      { id: 3, script: `设计时尚，颜值爆表` },
      { id: 4, script: `现在下单，限时优惠！` }
    ];
    return {
      success: true,
      message: '文案已生成（默认）',
      data: { scripts }
    };
  }
}

/**
 * 3. 生成视频片段
 * 调用 /api/generate-video (SSE 流式)
 * 使用每段的画面Prompt生成对应视频
 * @returns AsyncGenerator，实时yield segment事件，最后返回ToolResult
 */
export async function* generateVideoSegmentsStream(
  scripts: Array<{ id: number; script: string; prompt?: string }>,
  productImageUrl: string,
  productName: string,
  customHeaders?: Record<string, string>,
  ratio?: string // 视频比例：'16:9'横版 或 '9:16'竖版
): AsyncGenerator<{ type: 'segment_video' | 'result'; content?: unknown; data?: unknown }> {
  const videoRatio = ratio || '16:9'; // 默认16:9横版
  console.log('[Tool] 调用 /api/generate-video，每段使用对应Prompt');
  console.log(`[Tool] scripts数量=${scripts.length}, 视频比例=${videoRatio}`);
  
  try {
    const formData = new FormData();
    formData.append('productName', productName);
    formData.append('imageUrl', productImageUrl); // API 期望的参数名
    formData.append('ratio', videoRatio); // 传递视频比例
    
    // 将文案转为 JSON（包含每段的prompt），API 期望的参数名是 segments
    const segmentsForRequest = scripts.map(s => ({
      id: s.id,
      script: s.script,
      prompt: s.prompt || `${productName}产品展示，专业拍摄`
    }));
    formData.append('segments', JSON.stringify(segmentsForRequest));
    
    // generate-video 是 SSE 流式接口，使用fetch处理流式响应
    console.log(`[Tool] 调用generate-video API`);
    
    const fetchResponse = await fetch(`${BASE_URL}/api/generate-video`, {
      method: 'POST',
      headers: customHeaders,
      body: formData
    });
    
    if (!fetchResponse.ok) {
      throw new Error(`generate-video API请求失败: ${fetchResponse.status} ${fetchResponse.statusText}`);
    }
    
    // 使用ReadableStream处理SSE响应
    const reader = fetchResponse.body?.getReader();
    if (!reader) {
      throw new Error('无法获取响应流');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    const segments: Array<{
      id: number; 
      script: string; 
      videoPath?: string; 
      audioPath?: string;
      videoUrl?: string;
      audioUrl?: string;
      localVideoPath?: string;
      duration?: number;
    }> = [];
    const sessionId = Date.now().toString();
    
    // 逐行解析SSE事件
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一行（可能不完整）
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6).trim();
          if (!dataStr) continue;
          
          try {
            const data = JSON.parse(dataStr);
            console.log(`[Tool] 解析事件: type=${data.type}`);
            
            if (data.type === 'segment_video' || data.type === 'segment_complete' || data.type === 'segment') {
              const segmentId = data.content?.segmentId || data.content?.id || data.segmentId;
              const videoUrl = data.content?.videoUrl || data.videoUrl;
              const duration = data.content?.duration || data.duration;
              const scriptContent = data.content?.script || '';
              
              console.log(`[Tool] 解析视频片段: segmentId=${segmentId}, videoUrl=${redactUrl(videoUrl)}`);
              
              if (segmentId && videoUrl) {
                // 下载视频到本地（优先转存到对象存储）
                const videoFilename = `segment_${segmentId}_${Date.now()}.mp4`;
                const { signedUrl } = await downloadVideoToLocal(
                  videoUrl, 
                  'segments', 
                  videoFilename,
                  3
                );
                
                console.log(`[Tool] 视频 ${segmentId} 下载完成: signedUrl=${redactUrl(signedUrl)}`);
                
                const segment = {
                  id: segmentId,
                  segmentId: segmentId,
                  script: scriptContent || scripts[segmentId - 1]?.script || '',
                  videoUrl: signedUrl || videoUrl,
                  duration: duration || 4
                };
                
                segments.push(segment);
                
                // 实时yield segment_video事件
                console.log(`[Tool] yield segment_video事件: id=${segmentId}`);
                yield { type: 'segment_video', content: segment };
              }
            } else if (data.type === 'error') {
              console.error(`[Tool] generate-video错误: ${data.content?.message || data.message}`);
            } else if (data.type === 'complete') {
              console.log(`[Tool] generate-video完成事件`);
            }
          } catch (parseError) {
            console.error(`[Tool] JSON解析错误: ${safeLogError(parseError)}`);
          }
        }
      }
    }
    
    console.log(`[Tool] 视频片段解析完成，共 ${segments.length} 个片段`);
    
    // 按ID排序片段
    segments.sort((a, b) => a.id - b.id);
    
    // 检查是否有有效的视频URL
    const hasValidVideos = segments.some(s => s.videoUrl && s.videoUrl.length > 0);
    
    if (!hasValidVideos) {
      console.error('[Tool] 视频片段生成失败: 没有有效的视频URL');
      yield { 
        type: 'result', 
        data: {
          success: false,
          message: '视频片段生成失败，视频服务可能暂时不可用，请稍后重试',
          data: { 
            segments: scripts.map(s => ({
              id: s.id,
              script: s.script,
              videoUrl: undefined,
              duration: 4
            })),
            sessionId,
            currentStage: "script_generated"
          },
          error: '视频生成服务未返回有效视频URL'
        }
      };
      return;
    }
    
    // 输出调试日志
    segments.forEach((s, i) => {
      console.log(`[Tool] 片段 ${i + 1}: id=${s.id}, videoUrl=${redactUrl(s.videoUrl)}`);
    });
    
    // yield最终结果
    yield { 
      type: 'result', 
      data: {
        success: true,
        message: `视频片段生成完成，共 ${segments.length} 个`,
        data: { 
          segments,
          sessionId,
          currentStage: "video_generated"
        }
      }
    };
    
  } catch (error) {
    console.error('[Tool] generate-video 失败:', safeLogError(error));
    yield { 
      type: 'result', 
      data: {
        success: false,
        message: '视频片段生成失败，稍后可重试',
        data: { 
          segments: scripts.map(s => ({
            id: s.id,
            script: s.script,
            videoUrl: undefined,
            duration: 4
          }))
        },
        error: error instanceof Error ? error.message : '未知错误'
      }
    };
  }
}

/**
 * 3. 生成视频片段（兼容旧版本，保持回调接口）
 * 调用 /api/generate-video (SSE 流式)
 * 使用每段的画面Prompt生成对应视频
 * @param scripts 文案列表
 * @param productImageUrl 商品图片URL
 * @param productName 商品名称
 * @param customHeaders 自定义请求头
 * @param onSegmentComplete 单个片段完成时的回调（用于实时推送）
 */
export async function generateVideoSegments(
  scripts: Array<{ id: number; script: string; prompt?: string }>,
  productImageUrl: string,
  productName: string,
  customHeaders?: Record<string, string>,
  onSegmentComplete?: (segment: { id: number; videoUrl: string; audioUrl?: string; duration?: number; localVideoPath?: string; script: string }) => void
): Promise<ToolResult> {
  console.log('[Tool] 调用 /api/generate-video，每段使用对应Prompt');
  
  try {
    const formData = new FormData();
    formData.append('productName', productName);
    formData.append('imageUrl', productImageUrl); // API 期望的参数名
    
    // 将文案转为 JSON（包含每段的prompt），API 期望的参数名是 segments
    const segmentsForRequest = scripts.map(s => ({
      id: s.id,
      script: s.script,
      prompt: s.prompt || `${productName}产品展示，专业拍摄`
    }));
    formData.append('segments', JSON.stringify(segmentsForRequest));
    
    // generate-video 是 SSE 流式接口，使用fetch处理流式响应
    console.log(`[Tool] 调用generate-video API，scripts数量=${scripts.length}`);
    
    const fetchResponse = await fetch(`${BASE_URL}/api/generate-video`, {
      method: 'POST',
      headers: customHeaders,
      body: formData
    });
    
    if (!fetchResponse.ok) {
      throw new Error(`generate-video API请求失败: ${fetchResponse.status} ${fetchResponse.statusText}`);
    }
    
    // 使用ReadableStream处理SSE响应
    const reader = fetchResponse.body?.getReader();
    if (!reader) {
      throw new Error('无法获取响应流');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    const segments: Array<{
      id: number; 
      script: string; 
      videoPath?: string; 
      audioPath?: string;
      videoUrl?: string;
      audioUrl?: string;
      localVideoPath?: string;
      duration?: number;
    }> = [];
    const sessionId = Date.now().toString();
    
    // 逐行解析SSE事件
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一行（可能不完整）
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6).trim();
          if (!dataStr) continue;
          
          try {
            const data = JSON.parse(dataStr);
            console.log(`[Tool] 解析视频片段事件: type=${data.type}`);
            
            if (data.type === 'segment_video' || data.type === 'segment_complete' || data.type === 'segment') {
              const segmentId = data.content?.segmentId || data.content?.id || data.segmentId;
              const videoUrl = data.content?.videoUrl || data.videoUrl;
              const duration = data.content?.duration || data.duration;
              const scriptContent = data.content?.script || '';
              
              console.log(`[Tool] 解析视频片段事件: segmentId=${segmentId}, videoUrl=${redactUrl(videoUrl)}, duration=${duration}`);
              
              if (segmentId && videoUrl) {
                // 下载视频到本地（优先转存到对象存储）
                const videoFilename = `segment_${segmentId}_${Date.now()}.mp4`;
                const { signedUrl } = await downloadVideoToLocal(
                  videoUrl, 
                  'segments', 
                  videoFilename,
                  3
                );
                
                console.log(`[Tool] 视频片段 ${segmentId} 下载结果: signedUrl=${redactUrl(signedUrl)}`);
                
                const segment = {
                  id: segmentId,
                  script: scriptContent || scripts[segmentId - 1]?.script || '',
                  videoUrl: signedUrl || videoUrl,
                  localVideoPath: `/videos/segments/${videoFilename}`,
                  duration: duration || 4
                };
                
                segments.push(segment);
                
                // 回调通知单个片段完成
                if (onSegmentComplete) {
                  console.log(`[Tool] 回调通知片段 ${segmentId} 完成`);
                  onSegmentComplete(segment);
                }
              }
            } else if (data.type === 'error') {
              console.error(`[Tool] generate-video错误: ${data.content?.message || data.message}`);
            } else if (data.type === 'complete') {
              console.log(`[Tool] generate-video完成事件`);
            }
          } catch (parseError) {
            console.error(`[Tool] JSON解析错误: ${safeLogError(parseError)}`);
          }
        }
      }
    }
    
    console.log(`[Tool] 视频片段解析完成，共 ${segments.length} 个片段`);
    
    // 按ID排序片段
    segments.sort((a, b) => a.id - b.id);
    
    // 检查是否有有效的视频URL
    const hasValidVideos = segments.some(s => s.videoUrl && s.videoUrl.length > 0);
    
    if (!hasValidVideos) {
      console.error('[Tool] 视频片段生成失败: 没有有效的视频URL');
      return {
        success: false,
        message: '视频片段生成失败，视频服务可能暂时不可用，请稍后重试',
        data: { 
          segments: scripts.map(s => ({
            id: s.id,
            script: s.script,
            videoUrl: undefined,
            duration: 4
          })),
          sessionId,
          currentStage: "script_generated"
        },
        error: '视频生成服务未返回有效视频URL'
      };
    }
    
    // 输出调试日志
    segments.forEach((s, i) => {
      console.log(`[Tool] 片段 ${i + 1}: id=${s.id}, videoUrl=${redactUrl(s.videoUrl)}, localPath=[path]`);
    });
    
    return {
      success: true,
      message: `视频片段生成完成，共 ${segments.length} 个（已下载到本地）`,
      data: { 
        segments,
        sessionId,
        currentStage: "video_generated"
      }
    };
  } catch (error) {
    console.error('[Tool] generate-video 失败:', safeLogError(error));
    // 返回脚本信息（稍后可重试）
    const segments = scripts.map(s => ({
      id: s.id,
      script: s.script,
      videoPath: undefined,
      audioPath: undefined,
      duration: 4
    }));
    return {
      success: false,
      message: '视频片段生成失败，稍后可重试',
      data: { segments },
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

/**
 * 4. 合成最终视频
 * 直接使用 FFmpeg 合成（不调用 compose API）
 */
export async function composeFinalVideo(
  segments: Array<{ id: number; script: string; videoUrl?: string; audioUrl?: string; localVideoPath?: string; localAudioPath?: string }>,
  productName: string,
  options?: { bgmUrl?: string; embedSubtitle?: boolean; sessionId?: string },
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] composeFinalVideo: 开始合成最终视频');
  console.log('[Tool] 传入的 segments 数量:', segments?.length || 0);
  
  if (!segments || segments.length === 0) {
    return {
      success: false,
      message: '没有可合成的视频片段',
      error: 'segments 为空'
    };
  }
  
  const sessionId = options?.sessionId || Date.now().toString();
  const tmpDir = `/tmp/compose_${sessionId}`;
  
  try {
    // 创建临时目录
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    
    console.log(`[Tool] 创建临时目录: [path]`);
    
    // 按 ID 排序确保合成顺序正确
    const sortedSegments = [...segments].sort((a, b) => (a.id || 0) - (b.id || 0));
    console.log(`[Tool] 片段排序后的ID顺序: ${sortedSegments.map(s => s.id).join(', ')}`);
    
    // Step 1: 下载所有视频和音频文件到本地
    const localSegments: Array<{ videoPath: string; audioPath: string; script: string; duration: number }> = [];
    
    for (const segment of sortedSegments) {
      const segId = segment.id;
      console.log(`[Tool] 处理片段 ${segId}...`);
      
      // 下载视频
      const videoPath = path.join(tmpDir, `video_${segId}.mp4`);
      if (segment.videoUrl) {
        console.log(`[Tool] 下载视频 ${segId}: ${redactUrl(segment.videoUrl)}`);
        const videoResponse = await axios.get(segment.videoUrl, { 
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: customHeaders
        });
        fs.writeFileSync(videoPath, videoResponse.data);
        console.log(`[Tool] 视频 ${segId} 下载完成，大小: ${fs.statSync(videoPath).size} bytes`);
      } else {
        console.error(`[Tool] 片段 ${segId} 没有 videoUrl`);
        continue;
      }
      
      // 下载音频（如果有）
      const audioPath = path.join(tmpDir, `audio_${segId}.mp3`);
      if (segment.audioUrl) {
        console.log(`[Tool] 下载音频 ${segId}: ${redactUrl(segment.audioUrl)}`);
        const audioResponse = await axios.get(segment.audioUrl, { 
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: customHeaders
        });
        fs.writeFileSync(audioPath, audioResponse.data);
        console.log(`[Tool] 音频 ${segId} 下载完成，大小: ${fs.statSync(audioPath).size} bytes`);
      } else {
        console.log(`[Tool] 片段 ${segId} 没有 audioUrl，使用视频自带音频`);
        // 如果没有单独的音频，使用视频自带的音频
        fs.copyFileSync(videoPath, audioPath.replace('.mp3', '_from_video.mp4'));
      }
      
      // 获取音频时长
      let duration = 0;
      try {
        const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
        duration = parseFloat(execSync(durationCmd, { encoding: 'utf-8', timeout: 5000 }).trim()) || 0;
      } catch (e) {
        console.log(`[Tool] 无法获取音频时长，使用默认值 5秒`);
        duration = 5;
      }
      
      localSegments.push({
        videoPath,
        audioPath,
        script: segment.script,
        duration
      });
    }
    
    if (localSegments.length === 0) {
      return {
        success: false,
        message: '没有有效的视频片段可合成',
        error: '所有片段都缺少视频URL'
      };
    }
    
    console.log(`[Tool] 共 ${localSegments.length} 个有效片段准备合成`);
    
    // Step 2: 合并每个视频的音频（如果有单独音频）
    const mergedVideos: string[] = [];
    
    for (const seg of localSegments) {
      const mergedPath = seg.videoPath.replace('.mp4', '_merged.mp4');
      
      // 检查视频是否有音频轨道
      const probeCmd = `ffprobe -v quiet -show_streams -select_streams a "${seg.videoPath}"`;
      const probeOutput = execSync(probeCmd, { encoding: 'utf-8', timeout: 5000 });
      const hasAudioInVideo = probeOutput.includes('codec_type=audio');
      
      if (hasAudioInVideo) {
        // 视频已有音频，直接使用
        console.log(`[Tool] 视频已有音频轨道，直接使用`);
        fs.copyFileSync(seg.videoPath, mergedPath);
      } else if (fs.existsSync(seg.audioPath) && fs.statSync(seg.audioPath).size > 0) {
        // 合并音频和视频
        console.log(`[Tool] FFmpeg合并音视频...`);
        const mergeCmd = `ffmpeg -y -i "${seg.videoPath}" -i "${seg.audioPath}" -c:v copy -c:a aac -shortest "${mergedPath}"`;
        execSync(mergeCmd, { stdio: 'pipe', timeout: 30000 });
      } else {
        // 无音频，直接使用视频
        console.log(`[Tool] 无音频文件，使用原视频`);
        fs.copyFileSync(seg.videoPath, mergedPath);
      }
      
      mergedVideos.push(mergedPath);
    }
    
    // Step 3: 直接拼接视频（分段视频已有字幕，无需再添加）
    const listPath = path.join(tmpDir, 'filelist.txt');
    const listContent = mergedVideos.map(v => `file '${v}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf-8');
    
    // 直接使用拼接后的视频作为最终视频（分段视频已有字幕）
    const finalPath = path.join(tmpDir, `final_${Date.now()}.mp4`);
    console.log(`[Tool] FFmpeg拼接视频（分段已有字幕，无需再添加）...`);
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${finalPath}"`;
    execSync(concatCmd, { stdio: 'pipe', timeout: 60000 });
    console.log(`[Tool] 视频拼接完成: [path]`);
    
    // 获取最终视频时长
    const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalPath}"`;
    const finalDuration = parseFloat(execSync(durationCmd, { encoding: 'utf-8', timeout: 5000 }).trim()) || 0;
    console.log(`[Tool] 最终视频时长: ${finalDuration}秒，文件大小: ${fs.statSync(finalPath).size} bytes`);
    
    // Step 6: 上传到对象存储
    console.log(`[Tool] 上传最终视频到对象存储...`);
    const filename = `${productName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_final.mp4`;
    const key = `final/${sessionId}/${filename}`;
    
    // 读取文件内容并上传
    const fileContent = fs.readFileSync(finalPath);
    const uploadResult = await uploadLocalFile(fileContent, filename, 'video/mp4');
    const signedVideoUrl = uploadResult.signedUrl;
    
    console.log(`[Tool] 最终视频上传完成: ${redactUrl(signedVideoUrl)}`);
    
    // 清理临时文件
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log(`[Tool] 临时目录清理完成`);
    } catch (e) {
      console.log(`[Tool] 临时目录清理失败（可忽略）`);
    }
    
    return {
      success: true,
      message: `最终视频合成完成！时长 ${finalDuration}秒，已上传到对象存储（分段视频已有字幕）`,
      data: {
        finalVideoUrl: signedVideoUrl,
        finalVideoLocalPath: finalPath,
        // 字幕已在分段视频中嵌入，无需额外字幕文件
        duration: finalDuration,
        currentStage: "done"
      }
    };
  } catch (error) {
    console.error('[Tool] composeFinalVideo 失败:', safeLogError(error));
    
    // 清理临时文件
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      // 忽略清理错误
    }
    
    return {
      success: false,
      message: '视频合成失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

/**
 * 5. 修改文案
 * 调用 /api/generate-script（重新生成指定文案）
 */
export async function modifyScript(
  scriptId: number,
  newContent: string,
  productName: string,
  features: string[],
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] 修改文案', scriptId);
  
  // 直接返回修改后的文案
  return {
    success: true,
    message: `文案 ${scriptId} 已修改`,
    data: {
      modifiedScript: {
        id: scriptId,
        script: newContent
      }
    }
  };
}

/**
 * 6. 重新生成视频片段
 * 调用 /api/agent/regenerate
 */
export async function regenerateSegment(
  segmentId: number,
  script: string,
  prompt: string,
  productImageUrl: string,
  productName: string,
  folderPath?: string,
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] 调用 /api/agent/regenerate');
  console.log('[Tool] 使用画面Prompt:', prompt);
  
  try {
    const response = await axios.post(
      `${BASE_URL}/api/agent/regenerate`,
      {
        segmentId,
        script,
        prompt,
        imageUrl: productImageUrl,
        productName,
        folderPath
      },
      { 
        headers: { 
          ...customHeaders,
          'Content-Type': 'application/json'
        },
        timeout: 300000, // 5 分钟超时
        responseType: 'text'
      }
    );
    
    const segment = parseRegenerationResult(response.data, segmentId, script);
    return {
      success: true,
      message: `片段 ${segmentId} 重新生成完成`,
      data: {
        segment
      }
    };
  } catch (error) {
    console.error('[Tool] regenerate 失败:', safeLogError(error));
    return {
      success: false,
      message: `片段 ${segmentId} 重新生成失败`,
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

/**
 * 7. 上传图片（仅上传，不识别）
 * 调用 /api/upload-image
 */
export async function uploadImage(
  imageFile: File,
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] 调用 /api/upload-image');
  
  try {
    const formData = new FormData();
    formData.append('image', imageFile);
    
    const response = await axios.post(
      `${BASE_URL}/api/upload-image`,
      formData,
      { 
        headers: { 
          ...customHeaders,
          'Content-Type': 'multipart/form-data'
        }
      }
    );
    
    const result = response.data;
    return {
      success: true,
      message: '图片上传成功',
      data: {
        imageUrl: result.imageUrl,
        fileName: result.fileName
      }
    };
  } catch (error) {
    console.error('[Tool] upload-image 失败:', safeLogError(error));
    return {
      success: false,
      message: '图片上传失败',
      error: error instanceof Error ? error.message : '未知错误'
    };
  }
}

/**
 * 工具名称映射
 */
export const TOOL_NAMES = {
  UPLOAD_AND_IDENTIFY: 'uploadAndIdentifyProduct',
  GENERATE_SCRIPTS: 'generateScripts',
  GENERATE_VIDEO_SEGMENTS: 'generateVideoSegments',
  COMPOSE_FINAL_VIDEO: 'composeFinalVideo',
  MODIFY_SCRIPT: 'modifyScript',
  REGENERATE_SEGMENT: 'regenerateSegment',
  UPLOAD_IMAGE: 'uploadImage'
};