import { NextRequest } from 'next/server';
import { TTSClient, VideoGenerationClient, Config, HeaderUtils, S3Storage } from 'coze-coding-dev-sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StreamData {
  type: 'tts_start' | 'tts_complete' | 'video_start' | 'video_complete' | 'download' | 'error' | 'done';
  content: string | object;
  segmentId?: number;
}

function sendEvent(controller: ReadableStreamDefaultController, data: StreamData) {
  const encoder = new TextEncoder();
  const message = `data: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(encoder.encode(message));
}

// 下载文件到本地
function downloadFile(url: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);
    
    protocol.get(url, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(redirectUrl, localPath).then(resolve).catch(reject);
          return;
        }
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

// 使用 FFmpeg 获取音频时长
function getAudioDurationFFmpeg(audioPath: string): number {
  try {
    const cmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
    const output = execSync(cmd, { encoding: 'utf-8' }).trim();
    return parseFloat(output);
  } catch {
    return 4; // 默认4秒
  }
}

/**
 * 生成单段音频和视频
 * POST /api/video-task/generate-segment
 */
export async function POST(request: NextRequest) {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 支持 JSON 和 FormData 两种格式
        const contentType = request.headers.get('content-type') || '';
        let segmentId: number, script: string, prompt: string, imageUrl: string, folderPath: string, productName: string;
        
        if (contentType.includes('application/json')) {
          const json = await request.json();
          segmentId = json.segmentId;
          script = json.script;
          prompt = json.prompt;
          imageUrl = json.imageUrl;
          folderPath = json.folderPath;
          productName = json.productName;
        } else {
          const formData = await request.formData();
          segmentId = parseInt(formData.get('segmentId') as string);
          script = formData.get('script') as string;
          prompt = formData.get('prompt') as string;
          imageUrl = formData.get('imageUrl') as string;
          folderPath = formData.get('folderPath') as string;
          productName = formData.get('productName') as string;
        }

        if (!segmentId || !script || !prompt || !folderPath) {
          sendEvent(controller, { type: 'error', content: '缺少必要参数' });
          controller.close();
          return;
        }

        // 获取火山方舟配置
        const arkApiKey = process.env.ARK_API_KEY;
        const arkBaseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com';
        const videoModelEP = process.env.VIDEO_MODEL_EP || 'ep-20260514120705-pqv86';
        
        // TTS 客户端使用默认配置
        const defaultConfig = new Config({ timeout: 300000 });
        const ttsClient = new TTSClient(defaultConfig, customHeaders);
        
        // 视频生成客户端使用火山方舟配置
        const videoGenConfig = arkApiKey ? new Config({ 
          apiKey: arkApiKey,
          baseUrl: arkBaseUrl,
          timeout: 300000,
        }) : new Config({ timeout: 300000 });
        const videoClient = new VideoGenerationClient(videoGenConfig, arkApiKey ? undefined : customHeaders);
        
        const storage = new S3Storage();

        // 文件路径
        const audioDir = path.join(folderPath, 'audio');
        const videoDir = path.join(folderPath, 'video');
        const audioFileName = `audio_${segmentId}_${Date.now()}.mp3`;
        const videoFileName = `video_${segmentId}_${Date.now()}.mp4`;
        const audioPath = path.join(audioDir, audioFileName);
        const videoPath = path.join(videoDir, videoFileName);

        // Step 1: 生成 TTS 音频
        sendEvent(controller, { 
          type: 'tts_start', 
          content: `正在生成第 ${segmentId} 段配音...`,
          segmentId 
        });

        const ttsResult = await ttsClient.synthesize({
          uid: `segment_${segmentId}`,
          text: script,
          speaker: 'zh_female_mizai_saturn_bigtts',
          audioFormat: 'mp3',
        });

        if (!ttsResult.audioUri) {
          throw new Error('TTS生成失败');
        }

        // 下载音频到本地
        await downloadFile(ttsResult.audioUri, audioPath);
        
        // 获取音频时长
        const audioDuration = getAudioDurationFFmpeg(audioPath);
        
        sendEvent(controller, {
          type: 'tts_complete',
          content: {
            segmentId,
            audioUrl: `/${path.basename(folderPath)}/audio/${audioFileName}`,
            audioLocalPath: audioPath,
            duration: audioDuration,
          },
          segmentId,
        });

        // Step 2: 生成视频
        sendEvent(controller, {
          type: 'video_start',
          content: `正在生成第 ${segmentId} 段视频...`,
          segmentId,
        });

        const videoDuration = Math.max(5, audioDuration);
        
        // 构建 content 参数，使用正确的格式（与成功接口一致）
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' }
        > = [];
        
        // 先将图片上传到对象存储，确保URL可访问
        let accessibleImageUrl = imageUrl;
        if (imageUrl) {
          try {
            const storage = new S3Storage();
            const imageKey = await storage.uploadFromUrl({
              url: imageUrl,
              timeout: 30000,
            });
            accessibleImageUrl = await storage.generatePresignedUrl({
              key: imageKey,
              expireTime: 3600,
            });
            console.log('图片上传成功:', accessibleImageUrl.substring(0, 100) + '...');
          } catch (uploadError) {
            console.error('图片上传失败，使用原始URL:', uploadError);
          }
        }

        if (accessibleImageUrl) {
          content.push({
            type: 'image_url' as const,
            image_url: { url: accessibleImageUrl },
            role: 'first_frame' as const,
          });
        }
        
        content.push({
          type: 'text' as const,
          text: prompt,
        });

        console.log('视频生成参数:', JSON.stringify({ content, options: {
          model: videoModelEP,
          duration: videoDuration,
          ratio: '16:9',
          resolution: '720p',
          generateAudio: false,
          watermark: false,
        }}, null, 2));

        const videoResponse = await videoClient.videoGeneration(content as Parameters<VideoGenerationClient['videoGeneration']>[0], {
          model: videoModelEP,
          duration: videoDuration,
          ratio: '16:9',
          resolution: '720p',
          generateAudio: false,
          watermark: false,
        });

        if (!videoResponse.videoUrl) {
          throw new Error('视频生成失败');
        }

        // 下载视频到本地
        await downloadFile(videoResponse.videoUrl, videoPath);

        sendEvent(controller, {
          type: 'video_complete',
          content: {
            segmentId,
            videoUrl: `/${path.basename(folderPath)}/video/${videoFileName}`,
            videoLocalPath: videoPath,
            duration: videoDuration,
          },
          segmentId,
        });

        sendEvent(controller, {
          type: 'done',
          content: {
            segmentId,
            audio: {
              url: `/${path.basename(folderPath)}/audio/${audioFileName}`,
              localPath: audioPath,
              duration: audioDuration,
            },
            video: {
              url: `/${path.basename(folderPath)}/video/${videoFileName}`,
              localPath: videoPath,
              duration: videoDuration,
            },
          },
        });

        controller.close();
      } catch (error) {
        console.error('生成失败:', error);
        if (error instanceof Error) {
          console.error('错误详情:', error.message, error.stack);
        }
        // 尝试从错误中提取更多信息
        const errorObj = error as { response?: { data?: unknown; status?: number } };
        if (errorObj.response) {
          console.error('响应数据:', JSON.stringify(errorObj.response.data, null, 2));
          console.error('响应状态:', errorObj.response.status);
        }
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : '生成失败',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
