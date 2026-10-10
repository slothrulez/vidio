/**
 * 视频片段生成节点
 * 为每个脚本片段生成 TTS 音频和视频
 */

import { AgentStateType, Step, VideoSegment } from "../state";
import fs from "fs";
import axios from "axios";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { TTSClient, VideoGenerationClient, Config, S3Storage } from "coze-coding-dev-sdk";
import https from "https";
import http from "http";

const execAsync = promisify(exec);

// 视频生成 API 配置 - 从环境变量获取
const VIDEO_MODEL_EP = process.env.VIDEO_MODEL_EP || "ep-20260514120705-pqv86";
const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com";

/**
 * 下载文件到本地
 */
function downloadFile(url: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(localPath, () => {});
      reject(err);
    });
  });
}

/**
 * 获取音频时长
 */
async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    return parseFloat(stdout.trim()) || 5;
  } catch {
    return 5;
  }
}

/**
 * 重试机制
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 2000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`[Agent] 重试 ${i + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw new Error("重试次数耗尽");
}

/**
 * 生成单个片段（TTS + 视频）
 */
async function generateSegment(
  segment: VideoSegment,
  folderPath: string,
  productImageUrl: string,
  index: number
): Promise<Partial<VideoSegment>> {
  try {
    console.log(`[Agent] 片段 ${index + 1}: 开始生成 TTS`);
    
    // SDK 配置
    const defaultConfig = new Config({ timeout: 300000 });
    const ttsClient = new TTSClient(defaultConfig);
    
    // 视频生成客户端使用火山方舟配置（如果有 API Key）
    const videoGenConfig = ARK_API_KEY ? new Config({
      apiKey: ARK_API_KEY,
      baseUrl: ARK_BASE_URL,
      timeout: 300000,
    }) : new Config({ timeout: 300000 });
    const videoClient = new VideoGenerationClient(videoGenConfig);
    
    const storage = new S3Storage();
    
    // 文件路径
    const audioDir = path.join(folderPath, 'audio');
    const videoDir = path.join(folderPath, 'video');
    const audioFileName = `audio_${segment.id}_${Date.now()}.mp3`;
    const videoFileName = `video_${segment.id}_${Date.now()}.mp4`;
    const audioPath = path.join(audioDir, audioFileName);
    const videoPath = path.join(videoDir, videoFileName);
    
    // Step 1: 生成 TTS 音频
    const ttsResult = await ttsClient.synthesize({
      uid: `segment_${segment.id}`,
      text: segment.script,
      speaker: 'zh_female_mizai_saturn_bigtts',
      audioFormat: 'mp3',
    });
    
    if (!ttsResult.audioUri) {
      throw new Error("TTS 生成失败：没有返回音频 URL");
    }
    
    console.log(`[Agent] 片段 ${index + 1}: TTS 完成，下载音频`);
    
    // 下载音频
    await downloadFile(ttsResult.audioUri, audioPath);
    const audioDuration = await getAudioDuration(audioPath);
    
    console.log(`[Agent] 片段 ${index + 1}: 开始生成视频`);
    
    // 上传商品图片到对象存储
    let accessibleImageUrl = productImageUrl;
    if (productImageUrl) {
      try {
        const imageKey = await storage.uploadFromUrl({
          url: productImageUrl,
          timeout: 30000,
        });
        accessibleImageUrl = await storage.generatePresignedUrl({
          key: imageKey,
          expireTime: 3600,
        });
        console.log(`[Agent] 片段 ${index + 1}: 图片上传成功`);
      } catch (uploadError) {
        console.error(`[Agent] 片段 ${index + 1}: 图片上传失败，使用原始URL`, uploadError);
      }
    }
    
    if (!accessibleImageUrl) {
      throw new Error("没有商品图片 URL");
    }
    
    // 构建视频生成参数
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' }
    > = [];
    
    content.push({
      type: 'image_url' as const,
      image_url: { url: accessibleImageUrl },
      role: 'first_frame' as const,
    });
    
    content.push({
      type: 'text' as const,
      text: segment.prompt || segment.script,
    });
    
    const videoDuration = Math.max(5, audioDuration);
    
    // 生成视频（带重试）
    const generateVideo = async () => {
      console.log(`[Agent] 片段 ${index + 1}: 视频参数`, {
        model: VIDEO_MODEL_EP,
        duration: videoDuration,
        promptLength: segment.prompt?.length || 0,
        imageUrl: accessibleImageUrl?.substring(0, 50) + '...',
      });
      
      try {
        return await videoClient.videoGeneration(content as Parameters<VideoGenerationClient['videoGeneration']>[0], {
          model: VIDEO_MODEL_EP,
          duration: videoDuration,
          ratio: '16:9',
          resolution: '720p',
          generateAudio: false,
          watermark: false,
        });
      } catch (err: unknown) {
        console.error(`[Agent] 片段 ${index + 1}: 视频生成错误详情`, {
          message: err instanceof Error ? err.message : String(err),
          statusCode: err && typeof err === 'object' && 'statusCode' in err ? err.statusCode : undefined,
          response: axios.isAxiosError(err) ? err.response?.data : 'no response data',
        });
        throw err;
      }
    };
    
    const videoResult = await withRetry(generateVideo, 3, 2000);
    
    if (!videoResult.videoUrl) {
      throw new Error("视频生成失败：没有返回视频 URL");
    }
    
    console.log(`[Agent] 片段 ${index + 1}: 视频生成完成，下载视频`);
    
    // 下载视频
    await downloadFile(videoResult.videoUrl, videoPath);
    
    // 获取视频时长
    let videoDurationActual = videoDuration;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
      );
      videoDurationActual = parseFloat(stdout.trim()) || videoDuration;
    } catch {}
    
    console.log(`[Agent] 片段 ${index + 1}: 完成`);
    
    return {
      id: segment.id,
      script: segment.script,
      prompt: segment.prompt,
      audioUrl: ttsResult.audioUri,
      audioLocalPath: audioPath,
      audioDuration: audioDuration,
      videoUrl: videoResult.videoUrl,
      videoLocalPath: videoPath,
      videoDuration: videoDurationActual,
      isGenerating: false,
      isSelected: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Agent] 片段 ${index + 1}: 生成失败`, error);
    
    return {
      id: segment.id,
      script: segment.script,
      prompt: segment.prompt,
      isGenerating: false,
      isSelected: true,
      error: errorMessage,
    };
  }
}

/**
 * 视频片段生成节点
 */
export async function generateSegmentsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log(`[Agent] 进入 generateSegments 节点`);
  console.log(`[Agent] 当前 segments 数量: ${state.segments?.length || 0}`);
  console.log(`[Agent] 输入的 segments 状态:`, state.segments?.map(s => ({
    id: s.id,
    hasScript: !!s.script,
    hasPrompt: !!s.prompt,
  })));
  
  if (!state.segments || state.segments.length === 0) {
    return {
      errors: [...state.errors, "没有视频片段需要生成"],
      currentStep: Step.ERROR,
    };
  }
  
  if (!state.workDir) {
    return {
      errors: [...state.errors, "没有工作目录"],
      currentStep: Step.ERROR,
    };
  }
  
  // 并发生成所有片段
  const results = await Promise.all(
    state.segments.map((segment, index) =>
      generateSegment(segment, state.workDir!, state.productImageUrl!, index)
    )
  );
  
  // 合并结果
  const updatedSegments: VideoSegment[] = state.segments.map((original, index) => {
    const result = results[index];
    return {
      ...original,
      ...result,
    } as VideoSegment;
  });
  
  console.log(`[Agent] 所有片段生成完成`);
  
  console.log(`[Agent] 生成后的 segments 状态:`, updatedSegments.map(s => ({
    id: s.id,
    hasVideo: !!s.videoLocalPath,
    hasAudio: !!s.audioLocalPath,
    videoPath: s.videoLocalPath,
    error: s.error,
  })));
  
  // 检查是否有成功的片段
  const successCount = updatedSegments.filter(s => s.videoLocalPath).length;
  if (successCount === 0) {
    return {
      errors: [...state.errors, "所有视频片段生成失败"],
      currentStep: Step.ERROR,
    };
  }
  
  return {
    segments: updatedSegments,
    currentStep: Step.GENERATE_SEGMENTS,
  };
}