/**
 * 重新生成单个视频片段 API
 */

import { NextRequest } from "next/server";
import { VideoSegment, AgentStateType } from "@/agent";
import fs from "fs";
import path from "path";
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import { TTSClient, VideoGenerationClient, Config, S3Storage } from "coze-coding-dev-sdk";
import { safeLogError } from '@/lib/log-redact';

const execAsync = promisify(exec);

// 使用环境变量或默认配置
const COZE_API_KEY = process.env.COZE_API_KEY || "";
const COZE_API_BASE_URL = process.env.COZE_API_BASE_URL || "https://api.coze.cn";
const ARK_API_KEY = process.env.ARK_API_KEY || process.env.VIDEO_API_KEY || "";
const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";

export async function POST(request: NextRequest) {
  const body = await request.json();
  
  const { segmentId, script, prompt, imageUrl, folderPath } = body;
  
  console.log(`[Regenerate API] 重新生成片段 ${segmentId}`);
  
  // 创建 SSE 流
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (type: string, data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
      };
      
      try {
        sendEvent("start", { segmentId, message: "开始重新生成" });
        
        // 1. 生成 TTS (使用 SDK)
        sendEvent("tts_start", { segmentId });
        
        const defaultConfig = new Config({ timeout: 300000 });
        const finalHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${COZE_API_KEY}`,
        };
        const ttsClient = new TTSClient(defaultConfig, finalHeaders);
        
        const ttsResponse = await ttsClient.synthesize({
          uid: `user_${Date.now()}_${segmentId}`,
          text: script,
          speaker: 'zh_female_mizai_saturn_bigtts',
          audioFormat: 'mp3',
          speechRate: 0,
        });
        
        let audioPath = '';
        let audioDuration = 5;
        
        if (ttsResponse.audioUri) {
          const audioFileName = `audio_${segmentId}_${Date.now()}.mp3`;
          audioPath = path.join(folderPath || '/tmp', "audio", audioFileName);
          
          // 确保目录存在
          const audioDir = path.dirname(audioPath);
          if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
          }
          
          // 下载音频文件
          const audioResponse = await axios.get(ttsResponse.audioUri, { responseType: 'arraybuffer' });
          fs.writeFileSync(audioPath, audioResponse.data);
          
          // 获取音频时长
          const { stdout } = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
          );
          audioDuration = parseFloat(stdout.trim()) || 5;
        }
        
        sendEvent("tts_complete", {
          segmentId,
          audioUrl: ttsResponse.audioUri,
          audioLocalPath: audioPath,
          duration: audioDuration,
        });
        
        // 2. 生成视频 (使用 SDK)
        sendEvent("video_start", { segmentId });
        
        const videoGenConfig = ARK_API_KEY ? new Config({ 
          apiKey: ARK_API_KEY,
          baseUrl: ARK_BASE_URL,
          timeout: 300000,
        }) : new Config({ timeout: 300000 });
        
        const videoClient = new VideoGenerationClient(videoGenConfig, ARK_API_KEY ? undefined : finalHeaders);
        const videoModelEP = process.env.VIDEO_MODEL_EP || 'ep-20260514120705-pqv86';
        
        const videoResponse = await videoClient.videoGeneration(
          [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: prompt },
          ],
          {
            model: videoModelEP,
            duration: Math.round(audioDuration),
            ratio: "16:9",
            resolution: "720p",
            generateAudio: false,
            watermark: false,
          }
        );
        
        if (!videoResponse.videoUrl) {
          throw new Error("视频生成失败：未返回视频URL");
        }
        
        // 下载视频到本地
        const videoResponseData = await axios.get(videoResponse.videoUrl, { responseType: "arraybuffer" });
        const videoFileName = `video_${segmentId}_${Date.now()}.mp4`;
        const videoPath = path.join(folderPath || '/tmp', "video", videoFileName);
        
        // 确保目录存在
        const videoDir = path.dirname(videoPath);
        if (!fs.existsSync(videoDir)) {
          fs.mkdirSync(videoDir, { recursive: true });
        }
        
        fs.writeFileSync(videoPath, videoResponseData.data);
        
        sendEvent("video_complete", {
          segmentId,
          videoUrl: videoResponse.videoUrl,
          videoLocalPath: videoPath,
          duration: audioDuration,
        });
        
        // 3. 上传到对象存储
        const storage = new S3Storage();
        const videoBuffer = fs.readFileSync(videoPath);
        const uploadedVideoKey = await storage.uploadFile({
          fileContent: videoBuffer,
          fileName: `regenerate/${videoFileName}`,
          contentType: 'video/mp4',
        });
        const uploadedVideoUrl = await storage.generatePresignedUrl({ key: uploadedVideoKey, expireTime: 86400 });
        
        // 4. 完成
        sendEvent("done", {
          segmentId,
          audio: {
            url: ttsResponse.audioUri,
            localPath: audioPath,
            duration: audioDuration,
          },
          video: {
            url: uploadedVideoUrl || videoResponse.videoUrl,
            localPath: videoPath,
            duration: audioDuration,
          },
        });
        
      } catch (error) {
        console.error(`[Regenerate API] 错误:`, safeLogError(error));
        sendEvent("error", { segmentId, message: String(error) });
      }
      
      controller.close();
    },
  });
  
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}