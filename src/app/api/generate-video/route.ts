// 设置API路由最大执行时间为120秒（视频生成需要较长时间）
export const maxDuration = 120;

import { NextRequest } from 'next/server';
import { Config, VideoGenerationClient, VideoEditClient, S3Storage, TTSClient } from 'coze-coding-dev-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import { spawn, execSync } from 'child_process';
import { redactUrl, safeLogError } from '@/lib/log-redact';

// Types
interface ScriptSegment {
  id: number;
  script: string;
  prompt: string;
  duration?: number;
}

interface Subtitle {
  start: number;
  end: number;
  text: string;
}

// 中间文件信息
interface IntermediateFile {
  type: 'audio' | 'video' | 'merged_video';
  segmentId?: number;
  url: string;
  duration?: number;
  localPath?: string;
}

// 视频生成任务的所有中间文件
interface IntermediateFiles {
  taskId: string;
  audios: IntermediateFile[];
  videos: IntermediateFile[];
  mergedVideos: IntermediateFile[];
  finalVideo?: IntermediateFile;
}

interface SSEEvent {
  type: 'segment_start' | 'tts_start' | 'tts_complete' | 'segment_video' | 'audio_merge' | 'concat_start' | 'upload_start' | 'subtitle_start' | 'video_url' | 'subtitles' | 'complete' | 'done' | 'error' | 'intermediate_files';
  content: unknown;
  segmentId?: number;
  current?: number;
  total?: number;
}

// 中间文件存储目录前缀（对象存储）
const INTERMEDIATE_FOLDER = 'video_generation_intermediates';

// Send SSE event
function sendEvent(controller: ReadableStreamDefaultController, event: SSEEvent) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

// Download file from URL to local file
async function downloadFile(url: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(redirectUrl, outputPath).then(resolve).catch(reject);
          return;
        }
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

// Get audio duration using FFmpeg (returns precise float seconds)
async function getAudioDurationFFmpeg(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        if (!isNaN(duration)) {
          resolve(duration); // Return precise float duration
        } else {
          resolve(5); // Default to 5 seconds if parsing fails
        }
      } else {
        resolve(5); // Default to 5 seconds on error
      }
    });
    
    ffprobe.on('error', () => {
      resolve(5); // Default to 5 seconds on error
    });
  });
}

// Merge video and audio using FFmpeg
async function mergeVideoAudioFFmpeg(
  videoPath: string, 
  audioPath: string, 
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', // Overwrite output
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy', // Copy video stream
      '-c:a', 'aac', // Re-encode audio to AAC
      '-map', '0:v:0', // Use video from first input
      '-map', '1:a:0', // Use audio from second input
      '-shortest', // End when shortest stream ends
      outputPath
    ]);
    
    let errorOutput = '';
    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg merge failed with code ${code}: ${errorOutput}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

// Add subtitle to segment video using FFmpeg (hard subtitle)
// 根据视频比例调整字幕大小
async function addSubtitleToSegmentVideo(
  videoPath: string,
  outputPath: string,
  subtitleText: string,
  duration: number,
  ratio: string = '16:9'
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 根据视频比例调整字幕参数
    // 16:9横版视频：字体较大，底部居中
    // 9:16竖版视频：字体更大，底部居中
    let playResX: number, playResY: number, fontSize: number, marginV: number;
    
    if (ratio === '9:16') {
      // 竖版视频（1080x1920）
      playResX = 1080;
      playResY = 1920;
      fontSize = 96;  // 竖版字体更大，占高度约5%
      marginV = 80;   // 底部边距更大
    } else {
      // 横版视频（1920x1080）
      playResX = 1920;
      playResY = 1080;
      fontSize = 72;  // 横版字体适中，占高度约6.7%
      marginV = 60;   // 底部边距适中
    }
    
    console.log(`[字幕] 视频比例=${ratio}, 分辨率=${playResX}x${playResY}, 字体大小=${fontSize}, 底部边距=${marginV}`);
    
    // Create ASS subtitle format with styling
    const assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,SimHei,${fontSize},&HFFFFFF,&HFFFFFF,&H000000,&H000000,-1,0,0,0,100,100,0,0,1,4,2,2,30,30,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:${Math.floor(duration)}.${Math.round((duration % 1) * 100)},Default,,0,0,0,,${subtitleText}`;
    
    // Create temporary ASS file
    const assPath = videoPath.replace('.mp4', '.ass');
    fs.writeFileSync(assPath, assContent);
    
    const ffmpeg = spawn('ffmpeg', [
      '-y', // Overwrite output
      '-i', videoPath,
      '-vf', `ass=${assPath}`,
      '-c:a', 'copy', // Copy audio stream
      outputPath
    ]);
    
    let errorOutput = '';
    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      // Clean up temporary ASS file
      if (fs.existsSync(assPath)) {
        fs.unlinkSync(assPath);
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg subtitle failed with code ${code}: ${errorOutput}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      // Clean up temporary ASS file
      if (fs.existsSync(assPath)) {
        fs.unlinkSync(assPath);
      }
      reject(err);
    });
  });
}

// Sleep utility for exponential backoff
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Task cache to avoid duplicate video generation for the same segment
// Key: cache key (segment identifier), Value: Promise of video generation result
const videoTaskCache = new Map<string, Promise<{ videoUrl: string; taskId: string }>>();

// Generate cache key for video task
function getVideoTaskCacheKey(segmentIndex: number, prompt: string, duration: number): string {
  return `${segmentIndex}_${prompt}_${duration}`;
}

// Video generation with task caching to avoid duplicate generation
async function generateVideoWithTaskCache(
  videoClient: VideoGenerationClient,
  content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' | 'reference_image' }>,
  options: {
    model: string;
    duration: number;
    ratio: string;
    resolution: string;
    generateAudio: boolean;
    watermark?: boolean;
  },
  segmentIndex: number,
  cacheKey: string,
  maxRetries: number = 3
): Promise<{ videoUrl: string; taskId: string }> {
  // Check if there's already a task in progress for this segment
  const existingTask = videoTaskCache.get(cacheKey);
  if (existingTask) {
    console.log(`第 ${segmentIndex + 1} 段视频已有任务在执行，等待结果...`);
    return existingTask;
  }
  
  // Create new task promise
  const taskPromise = (async (): Promise<{ videoUrl: string; taskId: string }> => {
    const backoffDelays = [2000, 4000, 8000]; // 2s, 4s, 8s
    const lastTaskId: string | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`第 ${segmentIndex + 1} 段视频生成开始（尝试 ${attempt + 1}/${maxRetries + 1}）...`);
        
        const videoResponse = await videoClient.videoGeneration(
          content as Parameters<VideoGenerationClient['videoGeneration']>[0],
          options as Parameters<VideoGenerationClient['videoGeneration']>[1]
        );
        
        if (!videoResponse.videoUrl) {
          throw new Error('未返回视频URL');
        }
        
        // Clear cache after successful completion
        videoTaskCache.delete(cacheKey);
        
        console.log(`第 ${segmentIndex + 1} 段视频生成成功 (taskId: ${videoResponse.response.id})`);
        
        return { 
          videoUrl: videoResponse.videoUrl, 
          taskId: videoResponse.response.id 
        };
      } catch (error: unknown) {
        // 详细记录错误信息
        const errorDetails = {
          message: error instanceof Error ? error.message : String(error),
          statusCode: (error as { statusCode?: number }).statusCode,
          response: (error as { response?: unknown }).response,
          content: JSON.stringify(content),
          options: JSON.stringify(options),
        };
        console.error(`第 ${segmentIndex + 1} 段视频生成失败详情:`, safeLogError(errorDetails));
        
        const is429Error = error instanceof Error && 
          (error.message.includes('429') || 
           (error as { statusCode?: number }).statusCode === 429);
        
        if (is429Error && attempt < maxRetries) {
          const delay = backoffDelays[attempt];
          console.log(`第 ${segmentIndex + 1} 段视频生成遇到429限流，等待 ${delay/1000} 秒后重试（第 ${attempt + 1}/${maxRetries} 次）...`);
          await sleep(delay);
        } else {
          // Clear cache on final failure
          videoTaskCache.delete(cacheKey);
          throw error;
        }
      }
    }
    
    // Clear cache on failure
    videoTaskCache.delete(cacheKey);
    throw new Error(`第 ${segmentIndex + 1} 段视频生成失败，已重试${maxRetries}次`);
  })();
  
  // Store the promise in cache before execution
  videoTaskCache.set(cacheKey, taskPromise);
  
  return taskPromise;
}

// Get video duration using FFmpeg (returns precise float seconds)
async function getVideoDurationFFmpeg(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        if (!isNaN(duration)) {
          resolve(duration); // Return precise float duration
        } else {
          resolve(5); // Default to 5 seconds if parsing fails
        }
      } else {
        resolve(5); // Default to 5 seconds on error
      }
    });
    
    ffprobe.on('error', () => {
      resolve(5); // Default to 5 seconds on error
    });
  });
}

export async function POST(request: NextRequest) {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const useMockMode = customHeaders['x-run-mode'] === 'test_run';
  
  // Parse form data
  const formData = await request.formData();
  const productName = formData.get('productName') as string;
  const segmentsJson = formData.get('segments') as string;
  let imageUrl = formData.get('imageUrl') as string | null;
  const productImageFile = formData.get('productImage') as File | null;
  const ratio = (formData.get('ratio') as string) || '16:9'; // 默认16:9横版，可选9:16竖版
  
  console.log(`视频比例设置: ${ratio}`);

  // Upload product image BEFORE creating the stream (if needed)
  if (!imageUrl && productImageFile && productImageFile.size > 0) {
    try {
      console.log('正在上传商品图片...');
      const storage = new S3Storage();
      const arrayBuffer = await productImageFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fileName = `product_images/${Date.now()}_${productImageFile.name}`;
      
      const imageKey = await storage.uploadFile({
        fileContent: buffer,
        fileName: fileName,
        contentType: productImageFile.type || 'image/jpeg',
      });
      
      imageUrl = await storage.generatePresignedUrl({ key: imageKey, expireTime: 86400 });
      console.log('商品图片上传成功:', redactUrl(imageUrl));
    } catch (error) {
      console.error('商品图片上传失败:', safeLogError(error));
    }
  }

  if (!segmentsJson) {
    return new Response(JSON.stringify({ error: '缺少分段数据' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let segments: ScriptSegment[];
  try {
    segments = JSON.parse(segmentsJson);
  } catch {
    return new Response(JSON.stringify({ error: '分段数据格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!segments || segments.length === 0) {
    return new Response(JSON.stringify({ error: '分段数据为空' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 中间文件存储记录 - 用于本地快速合成新内容
  const intermediateFiles = {
    audios: [] as Array<{ segmentId: number; url: string; duration: number; script: string }>,
    segmentVideos: [] as Array<{ segmentId: number; url: string; duration: number }>,
    finalVideo: null as { url: string; duration: number } | null,
    subtitles: [] as Array<{ start: number; end: number; text: string }>,
  };

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Initialize clients with SDK default configuration
        const finalHeaders = useMockMode 
          ? { ...customHeaders, 'x-run-mode': 'test_run' }
          : customHeaders;
        
        // 火山方舟视频生成配置
        const arkApiKey = process.env.ARK_API_KEY;
        const arkBaseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com';
        const videoModelEP = process.env.VIDEO_MODEL_EP;
        
        console.log('视频生成配置:', { 
          hasApiKey: !!arkApiKey, 
          baseUrl: arkBaseUrl, 
          videoModelEP: videoModelEP 
        });
        
        // 视频生成客户端使用火山方舟配置
        const videoGenConfig = arkApiKey ? new Config({ 
          apiKey: arkApiKey,
          baseUrl: arkBaseUrl,
          timeout: 300000, // 5 minutes for video processing
        }) : new Config({ timeout: 300000 });
        
        // 其他客户端使用SDK默认配置
        const defaultConfig = new Config({ timeout: 300000 });
        
        const ttsClient = new TTSClient(defaultConfig, finalHeaders);
        // 视频生成使用火山方舟配置，不需要额外headers
        const videoClient = new VideoGenerationClient(videoGenConfig, arkApiKey ? undefined : finalHeaders);
        const videoEditClient = new VideoEditClient(defaultConfig, finalHeaders);
        const storage = new S3Storage();
        
        // 使用用户配置的EP或默认模型
        const videoModel = videoModelEP || 'doubao-seedance-1-5-pro-251215';

        // ==========================================
        // Step 1: Generate TTS audio for each segment
        // ==========================================
        interface AudioInfo {
          url: string;
          duration: number;
          segmentId: number;
          localPath: string;
        }
        
        // FFmpeg functions are defined at module level
        
        // 并发执行TTS生成，提高效率
        console.log(`正在并发生成 ${segments.length} 段TTS音频...`);
        sendEvent(controller, {
          type: 'tts_start',
          content: `正在并发生成 ${segments.length} 段配音...`,
          segmentId: 0,
          current: 0,
          total: segments.length,
        });
        
        // 创建所有TTS生成任务
        const ttsPromises = segments.map(async (segment, i) => {
          try {
            // Generate TTS audio for the script using synthesize method
            const ttsResponse = await ttsClient.synthesize({
              uid: `user_${Date.now()}_${i}`,
              text: segment.script,
              speaker: 'zh_female_mizai_saturn_bigtts', // Video dubbing female voice
              audioFormat: 'mp3',
              speechRate: 0,
            });
            
            if (ttsResponse.audioUri) {
              // Use FFmpeg to get real audio duration
              let realDuration = segment.duration || 5; // Default fallback
              let localAudioPath = '';
              
              try {
                console.log(`[TTS ${i + 1}] 正在下载音频并获取真实时长...`);
                // Download audio to local temp file
                localAudioPath = `/tmp/audio_${segment.id}_${Date.now()}_${i}.mp3`;
                await downloadFile(ttsResponse.audioUri, localAudioPath);
                
                // Use FFmpeg to get duration
                realDuration = await getAudioDurationFFmpeg(localAudioPath);
                console.log(`[TTS ${i + 1}] FFmpeg获取真实时长: ${realDuration}秒`);
              } catch (ffmpegError) {
                console.warn(`[TTS ${i + 1}] FFmpeg获取时长失败，使用估算值:`, safeLogError(ffmpegError));
                // Fallback to estimation
                const charCount = segment.script.length;
                realDuration = Math.max(5, Math.min(15, Math.ceil(charCount / 4)));
              }
              
              console.log(`[TTS ${i + 1}] 音频生成成功, 真实时长 ${realDuration}秒`);
              
              return {
                index: i,
                segmentId: segment.id,
                url: ttsResponse.audioUri,
                duration: realDuration,
                localPath: localAudioPath,
                script: segment.script,
                success: true,
              };
            } else {
              throw new Error('TTS未返回音频URL');
            }
          } catch (ttsError) {
            console.error(`[TTS ${i + 1}] 生成失败:`, safeLogError(ttsError));
            // Use default duration if TTS fails
            return {
              index: i,
              segmentId: segment.id,
              url: '',
              duration: segment.duration || 5,
              localPath: '',
              script: segment.script,
              success: false,
              error: String(ttsError),
            };
          }
        });
        
        // 并发执行所有TTS任务
        const ttsResults = await Promise.all(ttsPromises);
        
        // 按index排序，确保顺序正确
        ttsResults.sort((a, b) => a.index - b.index);
        
        // 处理结果并发送事件
        const audioInfos: AudioInfo[] = [];
        for (const result of ttsResults) {
          audioInfos.push({
            url: result.url,
            duration: result.duration,
            segmentId: result.segmentId,
            localPath: result.localPath,
          });
          
          // 发送每段TTS完成事件
          sendEvent(controller, {
            type: 'tts_complete',
            content: { 
              segmentId: result.segmentId, 
              audioUrl: result.url,
              duration: result.duration,
            },
            segmentId: result.index,
          });
          
          // 记录中间文件
          intermediateFiles.audios.push({
            segmentId: result.segmentId,
            url: result.url,
            duration: result.duration,
            script: result.script,
          });
        }
        
        // 发送TTS全部完成事件
        sendEvent(controller, {
          type: 'tts_complete',
          content: `所有 ${segments.length} 段配音已生成完成`,
          segmentId: 0,
          current: segments.length,
          total: segments.length,
        });

        // ==========================================
        // Step 2: Generate videos in parallel for efficiency
        // ==========================================
        const segmentVideoInfos: Array<{
          videoUrl: string;
          audioUrl: string;
          audioDuration: number; // 音频时长，用于字幕时间计算
          videoDuration: number; // 视频时长
          script: string;
        }> = [];
        
        // Send initial progress notification
        sendEvent(controller, {
          type: 'segment_start',
          content: `正在并发生成 ${segments.length} 段视频...`,
          segmentId: 0,
          current: 0,
          total: segments.length,
        });
        
        // Create video generation promises for all segments
        const videoGenerationPromises = segments.map(async (segment, i) => {
          const audioInfo = audioInfos[i];
          
          const content: Array<
            { type: 'text'; text: string } | 
            { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' | 'reference_image' }
          > = [];
          
          // Use product image as reference for video generation
          // Only first segment uses first_frame role to ensure product appears at start
          if (imageUrl) {
            if (i === 0) {
              content.push({
                type: 'image_url' as const,
                image_url: { url: imageUrl },
                role: 'first_frame' as const,
              });
            } else {
              // Other segments: reference image without role (API doesn't accept undefined role)
              content.push({
                type: 'image_url' as const,
                image_url: { url: imageUrl },
              });
            }
          }
          
          // Add the visual prompt
          const promptText = productName 
            ? `${productName}产品展示：${segment.prompt}`
            : segment.prompt;
          
          content.push({
            type: 'text' as const,
            text: promptText,
          });
          
          // Generate video with duration matching the audio (min 5 seconds for API limit)
          // API requires integer duration, so round to nearest integer
          const videoDuration = Math.max(5, Math.round(audioInfo.duration));
          
          console.log(`开始生成第 ${i + 1} 段视频（${videoDuration}秒，${ratio}比例）...`);
          
          // Generate cache key for this segment (include ratio to differentiate)
          const cacheKey = getVideoTaskCacheKey(i, promptText, videoDuration) + `_${ratio}`;
          
          // Use task caching to avoid duplicate generation
          const videoResponse = await generateVideoWithTaskCache(
            videoClient,
            content,
            {
              model: videoModel,
              duration: videoDuration,
              ratio: ratio, // 使用用户选择的视频比例
              resolution: '720p',
              generateAudio: false, // Don't generate audio, we'll add our own
              watermark: false, // Disable AI watermark
            },
            i,
            cacheKey,
            3 // max retries
          );
          
          return {
            index: i,
            segmentId: segment.id,
            videoUrl: videoResponse.videoUrl,
            audioUrl: audioInfo.url,
            audioDuration: audioInfo.duration,
            script: segment.script,
          };
        });
        
        // Use a counter to track completed videos (atomic increment)
        let completedCount = 0;
        
        // Wait for all video generations to complete (不在此处发送事件，等合并后再发送)
        const videoResults = await Promise.all(
          videoGenerationPromises.map(async (promise) => {
            const result = await promise;
            // Increment completed count atomically
            completedCount++;
            // 不发送segment_video事件，等音视频合并后再发送
            return result;
          })
        );
        
        // Sort by index to maintain order
        videoResults.sort((a, b) => a.index - b.index);
        
        for (const result of videoResults) {
          segmentVideoInfos.push({
            videoUrl: result.videoUrl,
            audioUrl: result.audioUrl,
            audioDuration: result.audioDuration,
            videoDuration: result.audioDuration,
            script: result.script,
          });
          
          // 记录中间文件
          intermediateFiles.segmentVideos.push({
            segmentId: result.segmentId,
            url: result.videoUrl,
            duration: result.audioDuration,
          });
        }

        // ==========================================
        // Step 3: Merge audio and video for each segment
        // ==========================================
        const mergedVideoUrls: string[] = [];
        const mergedDurations: number[] = []; // Store actual durations after merge
        
        for (let i = 0; i < segmentVideoInfos.length; i++) {
          const info = segmentVideoInfos[i];
          const segmentId = segments[i].id;
          
          if (info.audioUrl) {
            sendEvent(controller, {
              type: 'audio_merge',
              content: `正在为第 ${i + 1}/${segments.length} 段视频添加配音...`,
              segmentId: i + 1,
            });
            
            try {
              // Download video to local temp directory
              const videoFileName = `video_${segmentId}_${Date.now()}.mp4`;
              const localVideoPath = `/tmp/${videoFileName}`;
              
              console.log(`下载视频到本地: [path]`);
              await downloadFile(info.videoUrl, localVideoPath);
              
              // Get local audio path from audioInfos
              const audioInfo = audioInfos.find(a => a.segmentId === segmentId);
              const localAudioPath = audioInfo?.localPath;
              
              if (!localAudioPath || !fs.existsSync(localAudioPath)) {
                throw new Error(`音频文件不存在: ${localAudioPath}`);
              }
              
              // 验证音频文件是否有有效的音频流
              try {
                const audioProbeOutput = execSync(
                  `ffprobe -v quiet -show_streams -select_streams a "${localAudioPath}"`,
                  { encoding: 'utf-8', timeout: 5000 }
                );
                const audioHasStream = audioProbeOutput.includes('codec_type=audio');
                console.log(`[验证] 音频文件 ${segmentId} 是否有效: ${audioHasStream ? 'YES' : 'NO'}`);
                if (!audioHasStream) {
                  console.error(`[警告] 音频文件 ${segmentId} 无有效音频流，文件可能损坏!`);
                  // 输出音频文件信息
                  console.log(`音频文件详情: ${audioProbeOutput}`);
                }
              } catch (audioProbeError) {
                console.error(`[验证] FFprobe检查音频文件失败:`, safeLogError(audioProbeError));
              }
              
              // Use FFmpeg to merge audio and video
              const mergedFileName = `merged_${segmentId}_${Date.now()}.mp4`;
              const mergedFilePath = `/tmp/${mergedFileName}`;
              
              console.log(`FFmpeg合并音视频: [path]`);
              await mergeVideoAudioFFmpeg(localVideoPath, localAudioPath, mergedFilePath);
              
              // Get actual video duration after merge using FFmpeg
              const actualVideoDuration = await getVideoDurationFFmpeg(mergedFilePath);
              console.log(`合并后视频真实时长: ${actualVideoDuration}秒，音频时长: ${info.audioDuration}秒`);
              
              // Update only videoDuration, keep audioDuration for subtitles
              segmentVideoInfos[i].videoDuration = actualVideoDuration;
              mergedDurations.push(actualVideoDuration);
              
              // Add subtitle to the merged video
              sendEvent(controller, {
                type: 'audio_merge',
                content: `正在为第 ${i + 1}/${segments.length} 段视频添加字幕...`,
                segmentId: i + 1,
              });
              
              const subtitleFileName = `subtitle_${segmentId}_${Date.now()}.mp4`;
              const subtitleFilePath = `/tmp/${subtitleFileName}`;
              
              console.log(`FFmpeg添加字幕: [path], 视频比例: ${ratio}`);
              await addSubtitleToSegmentVideo(mergedFilePath, subtitleFilePath, info.script || '', actualVideoDuration, ratio);
              
              // Upload video with subtitle to object storage
              console.log('上传带字幕的视频...');
              const finalVideoBuffer = fs.readFileSync(subtitleFilePath);
              const finalVideoKey = await storage.uploadFile({
                fileContent: finalVideoBuffer,
                fileName: `videos/final_${segmentId}_${Date.now()}.mp4`,
                contentType: 'video/mp4',
              });
              const finalVideoUrl = await storage.generatePresignedUrl({
                key: finalVideoKey,
                expireTime: 86400,
              });
              
              mergedVideoUrls.push(finalVideoUrl);
              console.log(`视频 ${i + 1} FFmpeg音视频合并+字幕添加成功，视频${actualVideoDuration}秒，音频${info.audioDuration}秒`);
              
              // 验证合并后的视频是否有音频轨道（同步执行）
              try {
                const probeOutput = execSync(
                  `ffprobe -v quiet -show_streams -select_streams a "${mergedFilePath}"`,
                  { encoding: 'utf-8', timeout: 5000 }
                );
                const hasAudio = probeOutput.includes('codec_type=audio');
                console.log(`[验证] 合并后视频 ${i + 1} 是否有音频轨道: ${hasAudio ? 'YES' : 'NO'}`);
                if (!hasAudio) {
                  console.error(`[警告] 视频片段 ${i + 1} 缺少音频轨道!`);
                }
              } catch (probeError) {
                console.error(`[验证] FFprobe检查音频轨道失败:`, safeLogError(probeError));
              }
              
              // Clean up temp files (验证完成后再删除)
              fs.unlinkSync(localVideoPath);
              fs.unlinkSync(mergedFilePath);
              fs.unlinkSync(subtitleFilePath);
              
              // 发送segment_video事件，使用带字幕的视频URL（已包含音频和字幕）
              console.log(`[API] 发送segment_video事件: segmentId=${segmentId}, videoUrl=${redactUrl(finalVideoUrl)}`);
              sendEvent(controller, {
                type: 'segment_video',
                content: { 
                  segmentId: segmentId, 
                  videoUrl: finalVideoUrl, // 使用带字幕的视频URL
                  audioUrl: null, // 合并后不再需要单独的音频URL
                  duration: actualVideoDuration,
                  script: info.script,
                },
                segmentId: i + 1,
                current: i + 1,
                total: segments.length,
              });
              
            } catch (mergeError) {
              console.error(`FFmpeg音频合并失败 (${i + 1}):`, safeLogError(mergeError));
              // Fallback to original video URL and duration
              mergedVideoUrls.push(info.videoUrl);
              mergedDurations.push(info.videoDuration);
              
              // 发送segment_video事件（合并失败，使用原始URL）
              sendEvent(controller, {
                type: 'segment_video',
                content: { 
                  segmentId: segmentId, 
                  videoUrl: info.videoUrl, // 原始视频URL
                  audioUrl: info.audioUrl, // 需要单独的音频URL
                  duration: info.videoDuration,
                },
                segmentId: i + 1,
                current: i + 1,
                total: segments.length,
              });
            }
          } else {
            mergedVideoUrls.push(info.videoUrl);
            mergedDurations.push(info.videoDuration);
          }
        }

        // ==========================================
        // Step 4: Concatenate all videos (skip if only one segment)
        // ==========================================
        if (segments.length === 1) {
          // Use audioDuration for subtitle timing (audio starts at 0)
          const audioDuration = segmentVideoInfos[0].audioDuration;
          const subtitles: Subtitle[] = [{
            start: 0,
            end: audioDuration,
            text: segmentVideoInfos[0].script,
          }];
          
          sendEvent(controller, {
            type: 'complete',
            content: {
              videoUrl: mergedVideoUrls[0],
              subtitles: subtitles,
              duration: segmentVideoInfos[0].videoDuration,
            },
          });
          
          controller.close();
          return;
        }
        
        sendEvent(controller, {
          type: 'concat_start',
          content: `正在拼接 ${segments.length} 个视频片段...`,
        });

        // Transfer all videos to object storage for accessible URLs
        const accessibleVideoUrls: string[] = [];
        for (let i = 0; i < mergedVideoUrls.length; i++) {
          try {
            const uploadedKey = await storage.uploadFromUrl({
              url: mergedVideoUrls[i],
              timeout: 60000,
            });
            
            const accessibleUrl = await storage.generatePresignedUrl({
              key: uploadedKey,
              expireTime: 86400, // 24小时有效期
            });
            
            accessibleVideoUrls.push(accessibleUrl);
            console.log(`视频 ${i + 1} 转存成功`);
          } catch (transferError) {
            console.error(`视频 ${i + 1} 转存失败:`, safeLogError(transferError));
            // Return individual segments on failure
            // Use audioDuration for subtitle timing
            const subtitles = segmentVideoInfos.map((info, idx) => {
              const prevDuration = segmentVideoInfos.slice(0, idx).reduce((sum, i) => sum + i.audioDuration, 0);
              return {
                start: prevDuration,
                end: prevDuration + info.audioDuration,
                text: info.script,
              };
            });
            
            sendEvent(controller, {
              type: 'complete',
              content: {
                videoUrl: mergedVideoUrls[0],
                segmentVideos: segmentVideoInfos.map((info, idx) => ({
                  id: segments[idx].id,
                  script: info.script,
                  videoUrl: mergedVideoUrls[idx],
                  duration: info.videoDuration,
                })),
                subtitles: subtitles,
                duration: segmentVideoInfos.reduce((sum, i) => sum + i.videoDuration, 0),
                isSegmented: true,
              },
            });
            
            controller.close();
            return;
          }
        }

        // Use smooth transitions between segments
        const transitions = ['1182376', '1182356', '1182371', '1182374'];
        const selectedTransitions = segments.slice(0, -1).map((_, i) => 
          transitions[i % transitions.length]
        );

        let concatenatedVideoUrl: string = '';
        let totalDuration: number = 0;

        // Retry mechanism for concatenation
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`开始视频拼接 (第${attempt}次尝试)`);
            const concatResponse = await videoEditClient.concatVideos(
              accessibleVideoUrls,
              selectedTransitions.length > 0 ? { transitions: selectedTransitions } : undefined
            );

            if (!concatResponse.url) {
              throw new Error('视频拼接失败：未返回视频URL');
            }

            concatenatedVideoUrl = concatResponse.url;
            totalDuration = concatResponse.video_meta?.duration || 
              segmentVideoInfos.reduce((sum, i) => sum + i.videoDuration, 0);
            break;
          } catch (concatErr) {
            console.error(`视频拼接第${attempt}次失败:`, concatErr);
            if (attempt < 3) {
              await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
          }
        }

        if (!concatenatedVideoUrl) {
          // Return individual segments
          // Use audioDuration for subtitle timing
          const subtitles = segmentVideoInfos.map((info, idx) => {
            const prevDuration = segmentVideoInfos.slice(0, idx).reduce((sum, i) => sum + i.audioDuration, 0);
            return {
              start: prevDuration,
              end: prevDuration + info.audioDuration,
              text: info.script,
            };
          });
          
          sendEvent(controller, {
            type: 'complete',
            content: {
              videoUrl: mergedVideoUrls[0],
              segmentVideos: segmentVideoInfos.map((info, idx) => ({
                id: segments[idx].id,
                script: info.script,
                videoUrl: mergedVideoUrls[idx],
                duration: info.videoDuration,
              })),
              subtitles: subtitles,
              duration: segmentVideoInfos.reduce((sum, i) => sum + i.videoDuration, 0),
              isSegmented: true,
            },
          });
          
          controller.close();
          return;
        }

        // ==========================================
        // Step 5: Add subtitles to final video
        // ==========================================
        sendEvent(controller, {
          type: 'subtitle_start',
          content: '正在添加字幕到视频...',
        });

        // Generate subtitles based on AUDIO durations (not video durations)
        // Each audio starts at the beginning of its segment video
        const subtitles: Subtitle[] = [];
        let currentTime = 0;
        for (const info of segmentVideoInfos) {
          // Use audioDuration for subtitle timing
          subtitles.push({
            start: currentTime,
            end: currentTime + info.audioDuration,
            text: info.script,
          });
          currentTime += info.audioDuration;
        }

        console.log('字幕时间段（基于音频时长）:', subtitles.map(s => `${s.start}-${s.end}: ${s.text}`));

        const textList = subtitles.map(sub => ({
          start_time: sub.start,
          end_time: sub.end,
          text: sub.text,
        }));

        const subtitleConfig = {
          font_pos_config: {
            pos_x: '0',
            pos_y: '90%',
            width: '100%',
            height: '10%',
          },
          font_size: 36,
          font_color: '#FFFFFFFF',
          font_type: '1525745',
          background_color: '#00000088',
          background_border_width: 0,
          border_width: 1,
          border_color: '#00000088',
        };

        let finalVideoUrl = concatenatedVideoUrl;
        let signedVideoUrl: string | undefined;
        
        // 先将视频转存到对象存储，获取可访问的签名URL
        console.log('将视频转存到对象存储...');
        try {
          const storage = new S3Storage();
          // 从URL下载并上传到对象存储，返回存储的key
          const storageKey = await storage.uploadFromUrl({
            url: concatenatedVideoUrl,
            timeout: 60000, // 60秒超时
          });
          
          // 使用key生成可访问的签名URL（24小时有效期）
          signedVideoUrl = await storage.generatePresignedUrl({
            key: storageKey,
            expireTime: 86400, // 24小时有效期
          });
          
          if (signedVideoUrl) {
            finalVideoUrl = signedVideoUrl;
            console.log('视频转存成功，使用签名URL:', redactUrl(signedVideoUrl));
          }
        } catch (transferError) {
          console.error('视频转存失败:', safeLogError(transferError));
          // 继续使用原始URL
        }

        // 使用签名URL添加字幕（如果转存成功）
        if (signedVideoUrl) {
          try {
            console.log('使用签名URL添加字幕...');
            const subtitleResponse = await videoEditClient.addSubtitles(
              signedVideoUrl,
              subtitleConfig,
              { textList }
            );

            if (subtitleResponse.url) {
              finalVideoUrl = subtitleResponse.url;
              console.log('字幕添加成功');
            }
          } catch (subtitleError) {
            console.error('字幕添加失败:', safeLogError(subtitleError));
            // 继续使用无字幕的视频URL
          }
        } else {
          console.log('视频转存失败，跳过字幕添加，使用原始视频URL');
        }

        // 发送最终视频URL（可能是签名URL、带字幕URL或原始URL）

        sendEvent(controller, {
          type: 'video_url',
          content: finalVideoUrl,
        });

        sendEvent(controller, {
          type: 'subtitles',
          content: { subtitles },
        });

        sendEvent(controller, {
          type: 'done',
          content: JSON.stringify({
            videoUrl: finalVideoUrl,
            duration: totalDuration,
            segments: segments.length,
            intermediateFiles: intermediateFiles,
          }),
        });

        controller.close();
      } catch (error) {
        console.error('视频生成失败:', safeLogError(error));
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : '未知错误',
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
