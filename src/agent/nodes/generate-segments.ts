/**
 * Video segment generation node
 * Generates TTS audio and video for every script segment
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
import { safeLogError } from '@/lib/log-redact';

const execAsync = promisify(exec);

// Video generation API configuration from environment variables
const VIDEO_MODEL_EP = process.env.VIDEO_MODEL_EP || "ep-20260514120705-pqv86";
const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com";

/**
 * Download a file
 */
function downloadFile(url: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
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
 * Read the audio duration
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
 * Retry helper
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
      console.log(`[Agent] retry ${i + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw new Error("Retries exhausted");
}

/**
 * Generate one segment (TTS + video)
 */
async function generateSegment(
  segment: VideoSegment,
  folderPath: string,
  productImageUrl: string,
  index: number
): Promise<Partial<VideoSegment>> {
  try {
    console.log(`[Agent] segment ${index + 1}: generating TTS`);
    
    // SDK configuration
    const defaultConfig = new Config({ timeout: 300000 });
    const ttsClient = new TTSClient(defaultConfig);
    
    // The video client uses the provider configuration when an API key exists
    const videoGenConfig = ARK_API_KEY ? new Config({
      apiKey: ARK_API_KEY,
      baseUrl: ARK_BASE_URL,
      timeout: 300000,
    }) : new Config({ timeout: 300000 });
    const videoClient = new VideoGenerationClient(videoGenConfig);
    
    const storage = new S3Storage();
    
    // File paths
    const audioDir = path.join(folderPath, 'audio');
    const videoDir = path.join(folderPath, 'video');
    const audioFileName = `audio_${segment.id}_${Date.now()}.mp3`;
    const videoFileName = `video_${segment.id}_${Date.now()}.mp4`;
    const audioPath = path.join(audioDir, audioFileName);
    const videoPath = path.join(videoDir, videoFileName);
    
    // Step 1: generate TTS audio
    const ttsResult = await ttsClient.synthesize({
      uid: `segment_${segment.id}`,
      text: segment.script,
      speaker: 'zh_female_vv_uranus_bigtts',
      audioFormat: 'mp3',
    });
    
    if (!ttsResult.audioUri) {
      throw new Error("TTS failed: no audio URL returned");
    }
    
    console.log(`[Agent] segment ${index + 1}: TTS done, downloading audio`);
    
    // Download the audio
    await downloadFile(ttsResult.audioUri, audioPath);
    const audioDuration = await getAudioDuration(audioPath);
    
    console.log(`[Agent] segment ${index + 1}: generating video`);
    
    // Upload the product image to object storage
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
        console.log(`[Agent] segment ${index + 1}: image uploaded`);
      } catch (uploadError) {
        console.error(`[Agent] segment ${index + 1}: image upload failed, using the original URL`, safeLogError(uploadError));
      }
    }
    
    if (!accessibleImageUrl) {
      throw new Error("No product image URL");
    }
    
    // Build the video generation parameters
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
    
    // Generate the video with retries
    const generateVideo = async () => {
      console.log(`[Agent] segment ${index + 1}: video parameters`, {
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
        console.error(`[Agent] segment ${index + 1}: video generation error details`, {
          message: err instanceof Error ? err.message : String(err),
          statusCode: err && typeof err === 'object' && 'statusCode' in err ? err.statusCode : undefined,
          response: axios.isAxiosError(err) ? err.response?.data : 'no response data',
        });
        throw err;
      }
    };
    
    const videoResult = await withRetry(generateVideo, 3, 2000);
    
    if (!videoResult.videoUrl) {
      throw new Error("Video generation failed: no video URL returned");
    }
    
    console.log(`[Agent] segment ${index + 1}: video generated, downloading`);
    
    // Download the video
    await downloadFile(videoResult.videoUrl, videoPath);
    
    // Read the video duration
    let videoDurationActual = videoDuration;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
      );
      videoDurationActual = parseFloat(stdout.trim()) || videoDuration;
    } catch {}
    
    console.log(`[Agent] segment ${index + 1}: done`);
    
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
    console.error(`[Agent] segment ${index + 1}: generation failed`, safeLogError(error));
    
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
 * Video segment generation node
 */
export async function generateSegmentsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log(`[Agent] entering the generateSegments node`);
  console.log(`[Agent] current segment count: ${state.segments?.length || 0}`);
  console.log(`[Agent] input segments:`, state.segments?.map(s => ({
    id: s.id,
    hasScript: !!s.script,
    hasPrompt: !!s.prompt,
  })));
  
  if (!state.segments || state.segments.length === 0) {
    return {
      errors: [...state.errors, "No video segments to generate"],
      currentStep: Step.ERROR,
    };
  }
  
  if (!state.workDir) {
    return {
      errors: [...state.errors, "No working directory"],
      currentStep: Step.ERROR,
    };
  }
  
  // Generate every segment concurrently
  const results = await Promise.all(
    state.segments.map((segment, index) =>
      generateSegment(segment, state.workDir!, state.productImageUrl!, index)
    )
  );
  
  // Merge results
  const updatedSegments: VideoSegment[] = state.segments.map((original, index) => {
    const result = results[index];
    return {
      ...original,
      ...result,
    } as VideoSegment;
  });
  
  console.log(`[Agent] all segments generated`);
  
  console.log(`[Agent] segments after generation:`, updatedSegments.map(s => ({
    id: s.id,
    hasVideo: !!s.videoLocalPath,
    hasAudio: !!s.audioLocalPath,
    videoPath: s.videoLocalPath,
    error: s.error,
  })));
  
  // Check for any successful segment
  const successCount = updatedSegments.filter(s => s.videoLocalPath).length;
  if (successCount === 0) {
    return {
      errors: [...state.errors, "Every video segment failed"],
      currentStep: Step.ERROR,
    };
  }
  
  return {
    segments: updatedSegments,
    currentStep: Step.GENERATE_SEGMENTS,
  };
}