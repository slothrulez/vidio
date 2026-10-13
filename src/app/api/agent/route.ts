/**
 * Agent API 路由
 * 使用 SSE 流式输出，提供完整的视频生成流程
 * 
 * 支持两种模式：
 * - mode: "full" - 完整流程（识别商品 → 生成脚本 → 生成视频 → 合成）
 * - mode: "video" - 仅生成视频（跳过识别和脚本生成，直接从传入的脚本生成视频）
 */

import { NextRequest } from "next/server";
import { videoAgent } from "@/agent";
import { safeLogError } from '@/lib/log-redact';

// 定义简化的事件数据类型
interface EventData {
  productName: string;
  workDir: string;
  scripts: string[];
  prompts: string[];
  segments: Array<{
    id: number;
    script: string;
    audioUrl: string;
    audioLocalPath: string;
    audioDuration: number;
    videoUrl: string;
    videoLocalPath: string;
    videoDuration: number;
    isGenerating: boolean;
    isSelected: boolean;
  }>;
  finalVideoUrl: string;
  finalVideoLocalPath: string;
  finalSubtitles: Array<{ text: string; startTime: number; endTime: number }>;
  errors: string[];
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  
  console.log("[Agent API] 收到请求:", body);
  
  const mode = body.mode || "full"; // "full" 或 "video"
  
  // 创建 SSE 流式响应
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      // 发送 SSE 事件的辅助函数
      const sendEvent = (event: string, data: Record<string, unknown>) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };
      
      try {
        // 发送开始事件
        sendEvent("start", {
          message: `Agent 开始执行 (模式: ${mode})`,
          mode,
          timestamp: Date.now(),
        });
        
        // 准备输入状态
        const input: Record<string, unknown> = {
          productImageUrl: body.productImageUrl || "",
          productImageLocalPath: body.productImageLocalPath || "",
          productName: body.productName || "",
          productType: body.productType || "",
          selectedMaterials: body.selectedMaterials || [],
          selectedFeatures: body.selectedFeatures || [],
          customSellingPoints: body.customSellingPoints || [],
        };
        
        // 如果是 video 模式，需要传入已有的脚本和 Prompt
        if (mode === "video") {
          // 验证必要参数
          if (!body.scripts || !Array.isArray(body.scripts) || body.scripts.length === 0) {
            sendEvent("error", {
              message: "video 模式需要提供 scripts 数组",
              timestamp: Date.now(),
            });
            controller.close();
            return;
          }
          
          input.scripts = body.scripts;
          input.prompts = body.prompts || body.scripts; // 如果没有 prompts，使用 scripts 作为默认
          input.skipIdentify = true;
          input.skipScriptGeneration = true;
        }
        
        // 使用流式执行
        const generator = await videoAgent.streamExecute(input);
        
        const eventData: EventData = {
          productName: "",
          workDir: "",
          scripts: [],
          prompts: [],
          segments: [],
          finalVideoUrl: "",
          finalVideoLocalPath: "",
          finalSubtitles: [],
          errors: [],
        };
        
        for await (const chunk of generator) {
          const { node, state } = chunk;
          
          console.log(`[Agent API] 节点 ${node} 完成`);
          
          // 更新事件数据
          eventData.productName = state.productName || eventData.productName;
          eventData.workDir = state.workDir || eventData.workDir;
          eventData.scripts = state.scripts || eventData.scripts;
          eventData.prompts = state.prompts || eventData.prompts;
          
          if (state.segments) {
            eventData.segments = state.segments.map(seg => ({
              id: seg.id,
              script: seg.script,
              audioUrl: seg.audioUrl || "",
              audioLocalPath: seg.audioLocalPath || "",
              audioDuration: seg.audioDuration || 0,
              videoUrl: seg.videoUrl || "",
              videoLocalPath: seg.videoLocalPath || "",
              videoDuration: seg.videoDuration || 0,
              isGenerating: seg.isGenerating || false,
              isSelected: seg.isSelected || true,
            }));
          }
          
          eventData.finalVideoUrl = state.finalVideoUrl || eventData.finalVideoUrl;
          eventData.finalVideoLocalPath = state.finalVideoLocalPath || eventData.finalVideoLocalPath;
          eventData.finalSubtitles = state.finalSubtitles || eventData.finalSubtitles;
          eventData.errors = state.errors || eventData.errors;
          
          console.log(`[Agent API] 节点 ${node} 返回数据:`, safeLogError(state));
          
          // 发送节点完成事件
          sendEvent("node_complete", {
            node,
            step: state.currentStep || "",
            message: `节点 ${node} 执行完成`,
            data: eventData,
            timestamp: Date.now(),
          });
        }
        
        // 发送完成事件
        sendEvent("complete", {
          message: "视频生成完成",
          data: eventData,
          timestamp: Date.now(),
        });
        
      } catch (error) {
        console.error("[Agent API] 执行错误:", safeLogError(error));
        sendEvent("error", {
          message: `执行失败: ${error}`,
          timestamp: Date.now(),
        });
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