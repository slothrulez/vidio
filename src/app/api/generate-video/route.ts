// Allow this route to run for up to 120 seconds (video generation is slow)
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

// Intermediate file info
interface IntermediateFile {
  type: 'audio' | 'video' | 'merged_video';
  segmentId?: number;
  url: string;
  duration?: number;
  localPath?: string;
}

// Every intermediate file of a video job
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

// Object storage prefix for intermediate files
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
// Scale subtitles by video ratio
async function addSubtitleToSegmentVideo(
  videoPath: string,
  outputPath: string,
  subtitleText: string,
  duration: number,
  ratio: string = '16:9'
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Subtitle parameters by video ratio
    // 16:9 landscape: large font, bottom centre
    // 9:16 portrait: larger font, bottom centre
    let playResX: number, playResY: number, fontSize: number, marginV: number;
    
    if (ratio === '9:16') {
      // Portrait (1080x1920)
      playResX = 1080;
      playResY = 1920;
      fontSize = 96;  // larger portrait font, about 5% of height
      marginV = 80;   // larger bottom margin
    } else {
      // Landscape (1920x1080)
      playResX = 1920;
      playResY = 1080;
      fontSize = 72;  // landscape font, about 6.7% of height
      marginV = 60;   // moderate bottom margin
    }
    
    console.log(`[subtitles] ratio=${ratio}, resolution=${playResX}x${playResY}, fontSize=${fontSize}, marginV=${marginV}`);
    
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
    console.log(`Segment ${segmentIndex + 1} already has a running task, waiting...`);
    return existingTask;
  }
  
  // Create new task promise
  const taskPromise = (async (): Promise<{ videoUrl: string; taskId: string }> => {
    const backoffDelays = [2000, 4000, 8000]; // 2s, 4s, 8s
    const lastTaskId: string | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Segment ${segmentIndex + 1} video generation started (attempt ${attempt + 1}/${maxRetries + 1}）...`);
        
        const videoResponse = await videoClient.videoGeneration(
          content as Parameters<VideoGenerationClient['videoGeneration']>[0],
          options as Parameters<VideoGenerationClient['videoGeneration']>[1]
        );
        
        if (!videoResponse.videoUrl) {
          throw new Error('No video URL returned');
        }
        
        // Clear cache after successful completion
        videoTaskCache.delete(cacheKey);
        
        console.log(`Segment ${segmentIndex + 1} video generated (taskId: ${videoResponse.response.id})`);
        
        return { 
          videoUrl: videoResponse.videoUrl, 
          taskId: videoResponse.response.id 
        };
      } catch (error: unknown) {
        // Log error details
        const errorDetails = {
          message: error instanceof Error ? error.message : String(error),
          statusCode: (error as { statusCode?: number }).statusCode,
          response: (error as { response?: unknown }).response,
          content: JSON.stringify(content),
          options: JSON.stringify(options),
        };
        console.error(`Segment ${segmentIndex + 1} video generation failure details:`, safeLogError(errorDetails));
        
        const is429Error = error instanceof Error && 
          (error.message.includes('429') || 
           (error as { statusCode?: number }).statusCode === 429);
        
        if (is429Error && attempt < maxRetries) {
          const delay = backoffDelays[attempt];
          console.log(`Segment ${segmentIndex + 1} video generation hit 429 rate limiting, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries} of ${maxRetries})...`);
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
    throw new Error(`Segment ${segmentIndex + 1} video generation failed after ${maxRetries} retries`);
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
  const ratio = (formData.get('ratio') as string) || '16:9'; // default 16:9 landscape, 9:16 portrait optional
  
  console.log(`video ratio: ${ratio}`);

  // Upload product image BEFORE creating the stream (if needed)
  if (!imageUrl && productImageFile && productImageFile.size > 0) {
    try {
      console.log('Uploading the product image...');
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
      console.log('Product image uploaded:', redactUrl(imageUrl));
    } catch (error) {
      console.error('Product image upload failed:', safeLogError(error));
    }
  }

  if (!segmentsJson) {
    return new Response(JSON.stringify({ error: 'Missing segment data' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let segments: ScriptSegment[];
  try {
    segments = JSON.parse(segmentsJson);
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed segment data' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!segments || segments.length === 0) {
    return new Response(JSON.stringify({ error: 'Segment data is empty' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Intermediate file records for fast local recomposition
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
        
        // Video generation provider configuration
        const arkApiKey = process.env.ARK_API_KEY;
        const arkBaseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com';
        const videoModelEP = process.env.VIDEO_MODEL_EP;
        
        console.log('video generation config:', {
          hasApiKey: !!arkApiKey, 
          baseUrl: arkBaseUrl, 
          videoModelEP: videoModelEP 
        });
        
        // The video client uses the provider configuration
        const videoGenConfig = arkApiKey ? new Config({ 
          apiKey: arkApiKey,
          baseUrl: arkBaseUrl,
          timeout: 300000, // 5 minutes for video processing
        }) : new Config({ timeout: 300000 });
        
        // Other clients use the SDK defaults
        const defaultConfig = new Config({ timeout: 300000 });
        
        const ttsClient = new TTSClient(defaultConfig, finalHeaders);
        // Video generation uses the provider configuration; no extra headers
        const videoClient = new VideoGenerationClient(videoGenConfig, arkApiKey ? undefined : finalHeaders);
        const videoEditClient = new VideoEditClient(defaultConfig, finalHeaders);
        const storage = new S3Storage();
        
        // Configured endpoint or the default model
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
        
        // Run TTS concurrently
        console.log(`generating ${segments.length} TTS clips concurrently...`);
        sendEvent(controller, {
          type: 'tts_start',
          content: `Generating ${segments.length} voiceover clips...`,
          segmentId: 0,
          current: 0,
          total: segments.length,
        });
        
        // Create every TTS task
        const ttsPromises = segments.map(async (segment, i) => {
          try {
            // Generate TTS audio for the script using synthesize method
            const ttsResponse = await ttsClient.synthesize({
              uid: `user_${Date.now()}_${i}`,
              text: segment.script,
              speaker: 'zh_female_vv_uranus_bigtts', // English voiceover voice
              audioFormat: 'mp3',
              speechRate: 0,
            });
            
            if (ttsResponse.audioUri) {
              // Use FFmpeg to get real audio duration
              let realDuration = segment.duration || 5; // Default fallback
              let localAudioPath = '';
              
              try {
                console.log(`[TTS ${i + 1}] downloading audio to read its real duration...`);
                // Download audio to local temp file
                localAudioPath = `/tmp/audio_${segment.id}_${Date.now()}_${i}.mp3`;
                await downloadFile(ttsResponse.audioUri, localAudioPath);
                
                // Use FFmpeg to get duration
                realDuration = await getAudioDurationFFmpeg(localAudioPath);
                console.log(`[TTS ${i + 1}] FFmpeg real duration: ${realDuration}s`);
              } catch (ffmpegError) {
                console.warn(`[TTS ${i + 1}] FFmpeg duration failed, using the estimate:`, safeLogError(ffmpegError));
                // Fallback to estimation
                const charCount = segment.script.length;
                realDuration = Math.max(5, Math.min(15, Math.ceil(charCount / 4)));
              }
              
              console.log(`[TTS ${i + 1}] audio generated, real duration ${realDuration}s`);
              
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
              throw new Error('TTS returned no audio URL');
            }
          } catch (ttsError) {
            console.error(`[TTS ${i + 1}] generation failed:`, safeLogError(ttsError));
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
        
        // Run every TTS task
        const ttsResults = await Promise.all(ttsPromises);
        
        // Sort by index
        ttsResults.sort((a, b) => a.index - b.index);
        
        // Process results and emit events
        const audioInfos: AudioInfo[] = [];
        for (const result of ttsResults) {
          audioInfos.push({
            url: result.url,
            duration: result.duration,
            segmentId: result.segmentId,
            localPath: result.localPath,
          });
          
          // Emit a TTS-complete event per segment
          sendEvent(controller, {
            type: 'tts_complete',
            content: { 
              segmentId: result.segmentId, 
              audioUrl: result.url,
              duration: result.duration,
            },
            segmentId: result.index,
          });
          
          // Record the intermediate file
          intermediateFiles.audios.push({
            segmentId: result.segmentId,
            url: result.url,
            duration: result.duration,
            script: result.script,
          });
        }
        
        // Emit the all-TTS-complete event
        sendEvent(controller, {
          type: 'tts_complete',
          content: `All ${segments.length} voiceover clips are ready`,
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
          audioDuration: number; // audio duration for subtitle timing
          videoDuration: number; // video duration
          script: string;
        }> = [];
        
        // Send initial progress notification
        sendEvent(controller, {
          type: 'segment_start',
          content: `Generating ${segments.length} video segments...`,
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
            ? `${productName} product showcase: ${segment.prompt}`
            : segment.prompt;
          
          content.push({
            type: 'text' as const,
            text: promptText,
          });
          
          // Generate video with duration matching the audio (min 5 seconds for API limit)
          // API requires integer duration, so round to nearest integer
          const videoDuration = Math.max(5, Math.round(audioInfo.duration));
          
          console.log(`generating segment ${i + 1} (${videoDuration}s, ${ratio})...`);
          
          // Generate cache key for this segment (include ratio to differentiate)
          const cacheKey = getVideoTaskCacheKey(i, promptText, videoDuration) + `_${ratio}`;
          
          // Use task caching to avoid duplicate generation
          const videoResponse = await generateVideoWithTaskCache(
            videoClient,
            content,
            {
              model: videoModel,
              duration: videoDuration,
              ratio: ratio, // user-selected ratio
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
        
        // Wait for all video generations to complete (events are emitted after merging)
        const videoResults = await Promise.all(
          videoGenerationPromises.map(async (promise) => {
            const result = await promise;
            // Increment completed count atomically
            completedCount++;
            // segment_video is emitted after the audio/video merge
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
          
          // Record the intermediate file
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
              content: `Adding voiceover to segment ${i + 1}/${segments.length}...`,
              segmentId: i + 1,
            });
            
            try {
              // Download video to local temp directory
              const videoFileName = `video_${segmentId}_${Date.now()}.mp4`;
              const localVideoPath = `/tmp/${videoFileName}`;
              
              console.log(`downloaded video locally: [path]`);
              await downloadFile(info.videoUrl, localVideoPath);
              
              // Get local audio path from audioInfos
              const audioInfo = audioInfos.find(a => a.segmentId === segmentId);
              const localAudioPath = audioInfo?.localPath;
              
              if (!localAudioPath || !fs.existsSync(localAudioPath)) {
                throw new Error(`Audio file not found: ${localAudioPath}`);
              }
              
              // Verify the audio file has a valid stream
              try {
                const audioProbeOutput = execSync(
                  `ffprobe -v quiet -show_streams -select_streams a "${localAudioPath}"`,
                  { encoding: 'utf-8', timeout: 5000 }
                );
                const audioHasStream = audioProbeOutput.includes('codec_type=audio');
                console.log(`[check] audio file ${segmentId} valid: ${audioHasStream ? 'YES' : 'NO'}`);
                if (!audioHasStream) {
                  console.error(`[warning] audio file ${segmentId} has no audio stream; it may be corrupt`);
                  // Log audio file info
                  console.log(`audio file details: ${audioProbeOutput}`);
                }
              } catch (audioProbeError) {
                console.error(`[check] FFprobe audio check failed:`, safeLogError(audioProbeError));
              }
              
              // Use FFmpeg to merge audio and video
              const mergedFileName = `merged_${segmentId}_${Date.now()}.mp4`;
              const mergedFilePath = `/tmp/${mergedFileName}`;
              
              console.log(`FFmpeg merging audio and video: [path]`);
              await mergeVideoAudioFFmpeg(localVideoPath, localAudioPath, mergedFilePath);
              
              // Get actual video duration after merge using FFmpeg
              const actualVideoDuration = await getVideoDurationFFmpeg(mergedFilePath);
              console.log(`merged video duration ${actualVideoDuration}s, audio ${info.audioDuration}s`);
              
              // Update only videoDuration, keep audioDuration for subtitles
              segmentVideoInfos[i].videoDuration = actualVideoDuration;
              mergedDurations.push(actualVideoDuration);
              
              // Add subtitle to the merged video
              sendEvent(controller, {
                type: 'audio_merge',
                content: `Adding subtitles to segment ${i + 1}/${segments.length}...`,
                segmentId: i + 1,
              });
              
              const subtitleFileName = `subtitle_${segmentId}_${Date.now()}.mp4`;
              const subtitleFilePath = `/tmp/${subtitleFileName}`;
              
              console.log(`FFmpeg adding subtitles: [path], ratio: ${ratio}`);
              await addSubtitleToSegmentVideo(mergedFilePath, subtitleFilePath, info.script || '', actualVideoDuration, ratio);
              
              // Upload video with subtitle to object storage
              console.log('Uploading the subtitled video...');
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
              console.log(`video ${i + 1} merged with subtitles: video ${actualVideoDuration}s, audio ${info.audioDuration}s`);
              
              // Verify the merged video has an audio track
              try {
                const probeOutput = execSync(
                  `ffprobe -v quiet -show_streams -select_streams a "${mergedFilePath}"`,
                  { encoding: 'utf-8', timeout: 5000 }
                );
                const hasAudio = probeOutput.includes('codec_type=audio');
                console.log(`[check] merged video ${i + 1} has audio: ${hasAudio ? 'YES' : 'NO'}`);
                if (!hasAudio) {
                  console.error(`[warning] segment ${i + 1} has no audio track`);
                }
              } catch (probeError) {
                console.error(`[check] FFprobe audio track check failed:`, safeLogError(probeError));
              }
              
              // Clean up temp files (after verification)
              fs.unlinkSync(localVideoPath);
              fs.unlinkSync(mergedFilePath);
              fs.unlinkSync(subtitleFilePath);
              
              // Emit segment_video with the subtitled URL (audio and subtitles included)
              console.log(`[API] segment_video event: segmentId=${segmentId}, videoUrl=${redactUrl(finalVideoUrl)}`);
              sendEvent(controller, {
                type: 'segment_video',
                content: { 
                  segmentId: segmentId, 
                  videoUrl: finalVideoUrl, // subtitled video URL
                  audioUrl: null, // no separate audio URL after merging
                  duration: actualVideoDuration,
                  script: info.script,
                },
                segmentId: i + 1,
                current: i + 1,
                total: segments.length,
              });
              
            } catch (mergeError) {
              console.error(`FFmpeg audio merge failed (${i + 1}):`, safeLogError(mergeError));
              // Fallback to original video URL and duration
              mergedVideoUrls.push(info.videoUrl);
              mergedDurations.push(info.videoDuration);
              
              // Emit segment_video with the original URL (merge failed)
              sendEvent(controller, {
                type: 'segment_video',
                content: { 
                  segmentId: segmentId, 
                  videoUrl: info.videoUrl, // original video URL
                  audioUrl: info.audioUrl, // separate audio URL needed
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
          content: `Concatenating ${segments.length} video segments...`,
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
              expireTime: 86400, // valid for 24 hours
            });
            
            accessibleVideoUrls.push(accessibleUrl);
            console.log(`video ${i + 1} copied to storage`);
          } catch (transferError) {
            console.error(`video ${i + 1} copy failed:`, safeLogError(transferError));
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
            console.log(`starting concatenation (attempt ${attempt})`);
            const concatResponse = await videoEditClient.concatVideos(
              accessibleVideoUrls,
              selectedTransitions.length > 0 ? { transitions: selectedTransitions } : undefined
            );

            if (!concatResponse.url) {
              throw new Error('Concatenation failed: no video URL returned');
            }

            concatenatedVideoUrl = concatResponse.url;
            totalDuration = concatResponse.video_meta?.duration || 
              segmentVideoInfos.reduce((sum, i) => sum + i.videoDuration, 0);
            break;
          } catch (concatErr) {
            console.error(`concatenation attempt ${attempt} failed:`, concatErr);
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
          content: 'Adding subtitles to the video...',
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

        console.log('subtitle timings (from audio durations):', subtitles.map(s => `${s.start}-${s.end}: ${s.text}`));

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
        
        // Copy the video to object storage first to get a signed URL
        console.log('copying the video to object storage...');
        try {
          const storage = new S3Storage();
          // Download from the URL and upload to storage, returning the key
          const storageKey = await storage.uploadFromUrl({
            url: concatenatedVideoUrl,
            timeout: 60000, // 60s timeout
          });
          
          // Sign the key (valid for 24 hours)
          signedVideoUrl = await storage.generatePresignedUrl({
            key: storageKey,
            expireTime: 86400, // valid for 24 hours
          });
          
          if (signedVideoUrl) {
            finalVideoUrl = signedVideoUrl;
            console.log('video copied, using signed URL:', redactUrl(signedVideoUrl));
          }
        } catch (transferError) {
          console.error('video copy failed:', safeLogError(transferError));
          // Keep using the original URL
        }

        // Add subtitles using the signed URL when the copy succeeded
        if (signedVideoUrl) {
          try {
            console.log('adding subtitles via the signed URL...');
            const subtitleResponse = await videoEditClient.addSubtitles(
              signedVideoUrl,
              subtitleConfig,
              { textList }
            );

            if (subtitleResponse.url) {
              finalVideoUrl = subtitleResponse.url;
              console.log('subtitles added');
            }
          } catch (subtitleError) {
            console.error('subtitle step failed:', safeLogError(subtitleError));
            // Fall back to the video without subtitles
          }
        } else {
          console.log('video copy failed, skipping subtitles and using the original URL');
        }

        // Emit the final video URL (signed, subtitled or original)

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
        console.error('Video generation failed:', safeLogError(error));
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : 'Unknown error',
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
