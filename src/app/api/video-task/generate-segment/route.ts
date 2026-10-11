import { NextRequest } from 'next/server';
import { TTSClient, VideoGenerationClient, Config, HeaderUtils, S3Storage } from 'coze-coding-dev-sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { redactUrl, safeLogError } from '@/lib/log-redact';

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

// Download a file
function downloadFile(url: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);
    
    protocol.get(url, (response) => {
      // Follow redirects
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

// Read the audio duration with FFmpeg
function getAudioDurationFFmpeg(audioPath: string): number {
  try {
    const cmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
    const output = execSync(cmd, { encoding: 'utf-8' }).trim();
    return parseFloat(output);
  } catch {
    return 4; // default 4s
  }
}

/**
 * Generate one segment's audio and video
 * POST /api/video-task/generate-segment
 */
export async function POST(request: NextRequest) {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Accepts JSON and FormData
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
          sendEvent(controller, { type: 'error', content: 'Missing required parameters' });
          controller.close();
          return;
        }

        // Provider configuration
        const arkApiKey = process.env.ARK_API_KEY;
        const arkBaseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com';
        const videoModelEP = process.env.VIDEO_MODEL_EP || 'ep-20260514120705-pqv86';
        
        // The TTS client uses the defaults
        const defaultConfig = new Config({ timeout: 300000 });
        const ttsClient = new TTSClient(defaultConfig, customHeaders);
        
        // The video client uses the provider configuration
        const videoGenConfig = arkApiKey ? new Config({ 
          apiKey: arkApiKey,
          baseUrl: arkBaseUrl,
          timeout: 300000,
        }) : new Config({ timeout: 300000 });
        const videoClient = new VideoGenerationClient(videoGenConfig, arkApiKey ? undefined : customHeaders);
        
        const storage = new S3Storage();

        // File paths
        const audioDir = path.join(folderPath, 'audio');
        const videoDir = path.join(folderPath, 'video');
        const audioFileName = `audio_${segmentId}_${Date.now()}.mp3`;
        const videoFileName = `video_${segmentId}_${Date.now()}.mp4`;
        const audioPath = path.join(audioDir, audioFileName);
        const videoPath = path.join(videoDir, videoFileName);

        // Step 1: generate TTS audio
        sendEvent(controller, { 
          type: 'tts_start', 
          content: `Generating voiceover for segment ${segmentId}...`,
          segmentId 
        });

        const ttsResult = await ttsClient.synthesize({
          uid: `segment_${segmentId}`,
          text: script,
          speaker: 'zh_female_vv_uranus_bigtts',
          audioFormat: 'mp3',
        });

        if (!ttsResult.audioUri) {
          throw new Error('TTS generation failed');
        }

        // Download the audio
        await downloadFile(ttsResult.audioUri, audioPath);
        
        // Read the audio duration
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

        // Step 2: generate the video
        sendEvent(controller, {
          type: 'video_start',
          content: `Generating video for segment ${segmentId}...`,
          segmentId,
        });

        const videoDuration = Math.max(5, audioDuration);
        
        // Build the content parameter in the format the API expects
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' }
        > = [];
        
        // Upload the image to object storage first so the URL is reachable
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
            console.log('Image uploaded:', redactUrl(accessibleImageUrl));
          } catch (uploadError) {
            console.error('Image upload failed, using the original URL:', safeLogError(uploadError));
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

        console.log('video generation parameters:', JSON.stringify({ content, options: {
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
          throw new Error('Video generation failed');
        }

        // Download the video
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
        console.error('Generation failed:', safeLogError(error));
        if (error instanceof Error) {
          console.error('Error details:', safeLogError(error));
        }
        // Extract more detail from the error
        const errorObj = error as { response?: { data?: unknown; status?: number } };
        if (errorObj.response) {
          console.error('Response data:', safeLogError(errorObj.response.data));
          console.error('Response status:', errorObj.response.status);
        }
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : 'Generation failed',
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
