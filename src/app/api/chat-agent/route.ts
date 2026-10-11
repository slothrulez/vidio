// 问答式带货视频生成 Agent API - 对话式交互

import { NextRequest, NextResponse } from "next/server";
import { HeaderUtils } from "coze-coding-dev-sdk";
import { chatNodeStream } from "@/agent/chat-node";
import { getDefaultState, ChatAgentState, AgentSSEMessage } from "@/agent/chat-state";
import { redactUrl, safeLogError } from '@/lib/log-redact';

// 会话存储（简单实现，生产环境应使用数据库）
const sessions = new Map<string, ChatAgentState>();

// POST 处理对话请求
export async function POST(request: NextRequest) {
  console.log("[Chat Agent API] 收到请求");
  
  const body = await request.json();
  const { sessionId, message, imageUrl, auxiliaryImages, productName, voiceLanguage, scripts, segments, videoRatio } = body;
  
  // 获取或创建会话
  const state: ChatAgentState = sessionId ? sessions.get(sessionId) || getDefaultState() : getDefaultState();
  // 使用更唯一的ID生成方式（时间戳 + 随机数）
  const newSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  
  // 如果用户上传新图片，不恢复旧的生成数据（让流程重新开始）
  // 只有在没有上传图片时，才恢复前端传来的scripts/segments数据
  const isNewImageUpload = !!imageUrl;
  
  if (!isNewImageUpload) {
    // 如果前端传递了scripts/segments数据，但state中没有，则使用前端数据作为备用
    if (scripts && scripts.length > 0 && (!state.scripts || state.scripts.length === 0)) {
      state.scripts = scripts;
      console.log(`[API] 从前端恢复scripts: ${scripts.length} 段文案`);
    }
    if (segments && segments.length > 0 && (!state.segments || state.segments.length === 0)) {
      state.segments = segments;
      console.log(`[API] 从前端恢复segments: ${segments.length} 个视频片段`);
    }
  }
  
  console.log(`[API] 会话恢复: sessionId=${sessionId}, newSessionId=${newSessionId}, isNewImageUpload=${isNewImageUpload}, scripts=${state.scripts ? state.scripts.length : '无'}, stage=${state.currentStage}`);
  
  // 添加用户消息到历史
  const userMessage: { role: "user"; content: string } = {
    role: "user",
    content: message
  };
  
  // 如果有图片，添加图片信息到消息
  if (imageUrl) {
    // 用户上传了新的商品图片，需要清除之前的生成状态，重新开始流程
    console.log(`[API] 用户上传新图片，清除之前的生成状态（scripts、segments、finalVideoUrl等）`);
    state.scripts = []; // 清除文案
    state.segments = []; // 清除视频片段
    state.finalVideoUrl = undefined; // 清除最终视频URL
    state.finalVideoPath = undefined;
    state.localVideoPath = undefined;
    state.finalDuration = undefined;
    state.subtitleUrl = undefined;
    state.features = []; // 清除卖点
    state.productName = undefined; // 清除商品名称（等待重新识别）
    state.currentStage = "idle"; // 重置阶段为初始状态
    
    // 构建多图片消息
    let imageMessage = `${message}\n\n【商品图片信息】`;
    imageMessage += `\n主图片（重点参考）：${imageUrl}`;
    
    state.productImageUrl = imageUrl; // 存储主图片 URL
    
    // 如果有辅助图片，添加到消息和状态
    if (auxiliaryImages && auxiliaryImages.length > 0) {
      imageMessage += `\n辅助图片（补充参考）：`;
      auxiliaryImages.forEach((img: string, index: number) => {
        imageMessage += `\n  - 图片${index + 1}: ${img}`;
      });
      state.auxiliaryImages = auxiliaryImages; // 存储辅助图片 URL列表
    }
    
    userMessage.content = imageMessage;
  }
  
  // 如果有商品名称，预存储
  if (productName) {
    state.productName = productName;
  }
  
  // 如果有配音语言，预存储
  if (voiceLanguage) {
    state.voiceLanguage = voiceLanguage;
  }
  
  // 如果有视频比例，预存储
  if (videoRatio) {
    state.videoRatio = videoRatio;
    console.log(`[API] 视频比例设置为: ${videoRatio}`);
  }
  
  state.messages = [...state.messages, userMessage];
  
  // 提取请求头
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  
  const encoder = new TextEncoder();
  
  // 使用 TransformStream 创建持续的 SSE 流
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    }
  });
  
  const writer = transformStream.writable.getWriter();
  
  // 后台处理 generator
  (async () => {
    try {
      const generator = chatNodeStream(state, customHeaders);
      
      for await (const agentMessage of generator) {
        // 记录每个事件类型（写入到日志文件）
        const eventLog = `[chat-agent API] 发送事件: type=${agentMessage.type}`;
        console.log(eventLog);
        // 同时写入到app.log（通过info日志）
        console.info(`[chat-agent API] 发送事件: type=${agentMessage.type}`);
        
        if (agentMessage.type === 'segment_video') {
          const segContent = agentMessage.content as { segmentId?: number; videoUrl?: string };
          console.log(`[chat-agent API] segment_video详情: segmentId=${segContent.segmentId}, videoUrl=${redactUrl(segContent.videoUrl)}`);
        }
        
        const eventData = JSON.stringify({
          type: agentMessage.type,
          content: agentMessage.content,
          data: agentMessage.data,
          sessionId: newSessionId
        });
        
        // 写入SSE流
        try {
          await writer.write(encoder.encode(`data: ${eventData}\n\n`));
        } catch (writeError) {
          console.error(`[chat-agent API] 写入失败: ${safeLogError(writeError)}`);
        }
        
        // 收集状态更新
        if (agentMessage.type === "complete" && agentMessage.data) {
          const result = agentMessage.data as { result?: { data?: Record<string, unknown> } };
          if (result.result?.data) {
            const toolData = result.result.data;
            if (toolData.productImageUrl) state.productImageUrl = toolData.productImageUrl as string;
            if (toolData.productName) state.productName = toolData.productName as string;
            if (toolData.category) state.category = toolData.category as string;
            if (toolData.features) state.features = toolData.features as string[];
            if (toolData.scripts) state.scripts = toolData.scripts as Array<{ id: number; script: string; feature: string; prompt?: string }>;
            if (toolData.currentStage) state.currentStage = toolData.currentStage as ChatAgentState["currentStage"];
          }
        }
        
        // 处理 tool_result 更新状态
        // 注意：有两种发送格式：
        // 1. 视频生成特殊处理：{ type: "tool_result", content: { success, message, data: {...} } }
        // 2. 一般工具调用：{ type: "tool_result", content: message, data: { success, message, data: {...} } }
        if (agentMessage.type === "tool_result") {
          // 兼容两种格式：从content或data中提取toolData
          const contentObj = agentMessage.content && typeof agentMessage.content === 'object' 
            ? (agentMessage.content as Record<string, unknown>) 
            : null;
          const dataObj = agentMessage.data as Record<string, unknown> | undefined;
          
          // 格式1：content包含完整对象，直接取content.data
          // 格式2：content是字符串，取data.data
          const outerData = contentObj || dataObj;
          const toolData = (outerData?.data || outerData) as Record<string, unknown> | undefined;
          
          if (toolData) {
            console.log(`[API] tool_result 收到: scripts=${toolData.scripts ? `${(toolData.scripts as Array<unknown>).length}段` : '无'}, segments=${toolData.segments ? `${(toolData.segments as Array<unknown>).length}个` : '无'}, stage=${toolData.currentStage || '无'}`);
            if (toolData.productImageUrl) state.productImageUrl = toolData.productImageUrl as string;
            if (toolData.productName) state.productName = toolData.productName as string;
            if (toolData.features) state.features = toolData.features as string[];
            if (toolData.scripts) {
              state.scripts = toolData.scripts as Array<{ id: number; script: string; feature: string; prompt?: string }>;
              console.log(`[API] tool_result 更新 state.scripts: ${state.scripts.length} 段文案`);
            }
            if (toolData.segments) {
              state.segments = toolData.segments as Array<{
                id: number;
                script: string;
                feature: string;
                prompt?: string;
                audioPath?: string;
                audioUrl?: string;
                videoPath?: string;
                videoUrl?: string;
                duration: number;
              }>;
              console.log(`[API] 更新 state.segments: ${state.segments.length} 个片段`);
              // 详细日志：检查segments是否包含videoUrl
              (toolData.segments as Array<{id?: number; videoUrl?: string}>).forEach((seg, i) => {
                console.log(`[API] tool_result segment[${i}]: id=${seg.id}, hasVideo=${!!seg.videoUrl}, videoUrl=${redactUrl(seg.videoUrl)}`);
              });
              if (state.segments.length > 0 && toolData.currentStage) {
                state.currentStage = toolData.currentStage as ChatAgentState["currentStage"];
              }
            }
            if (toolData.finalVideoUrl) {
              state.finalVideoUrl = toolData.finalVideoUrl as string;
              state.currentStage = "done";
            }
            if (toolData.finalVideoPath) state.finalVideoPath = toolData.finalVideoPath as string;
            if (toolData.finalDuration) state.finalDuration = toolData.finalDuration as number;
            if (toolData.subtitleUrl) state.subtitleUrl = toolData.subtitleUrl as string;
            if (toolData.currentStage) state.currentStage = toolData.currentStage as ChatAgentState["currentStage"];
          }
        }
        
        // 处理 wait_feedback 更新状态（注意：后端发送的是content.state，不是data.state）
        if (agentMessage.type === "wait_feedback") {
          // 兼容两种格式：content.state 和 data.state
          const contentData = agentMessage.content;
          const contentState = contentData && typeof contentData === 'object' && 'state' in contentData
            ? (contentData.state as ChatAgentState)
            : null;
          const dataState = agentMessage.data && typeof agentMessage.data === 'object' && 'state' in agentMessage.data
            ? (agentMessage.data.state as ChatAgentState)
            : null;
          const stateData = contentState || dataState;
          if (stateData) {
            console.log(`[API] wait_feedback 更新状态: segments=${stateData.segments?.length || 0}个, stage=${stateData.currentStage}`);
            if (stateData.segments) {
              state.segments = stateData.segments;
              // 详细日志：检查segments是否包含videoUrl
              stateData.segments.forEach((seg, i) => {
                console.log(`[API] wait_feedback segment[${i}]: id=${seg.id}, hasVideo=${!!seg.videoUrl}, videoUrl=${redactUrl(seg.videoUrl)}`);
              });
            }
            state.productImageUrl = stateData.productImageUrl;
            state.productName = stateData.productName;
            state.features = stateData.features;
            state.scripts = stateData.scripts;
            state.currentStage = stateData.currentStage;
          }
        }
      }
      
      // 保存会话
      sessions.set(newSessionId, state);
      
      // 详细日志：检查最终state.segments是否包含videoUrl
      console.log(`[API] 最终state_update: segments=${state.segments?.length || 0}个, stage=${state.currentStage}`);
      if (state.segments && state.segments.length > 0) {
        state.segments.forEach((seg, i) => {
          console.log(`[API] 最终state_update segment[${i}]: id=${seg.id}, hasVideo=${!!seg.videoUrl}, videoUrl=${redactUrl(seg.videoUrl)}`);
        });
      }
      
      // 发送最终状态
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: "state_update",
        sessionId: newSessionId,
        data: {
          productImageUrl: state.productImageUrl,
          productName: state.productName,
          features: state.features,
          scripts: state.scripts,
          segments: state.segments,
          finalVideoUrl: state.finalVideoUrl,
          currentStage: state.currentStage
        }
      })}\n\n`));
      
      await writer.close();
    } catch (error) {
      // 区分正常的用户取消和真正的错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("ResponseAborted") || errorMessage.includes("aborted") || errorMessage.includes("cancel")) {
        // 用户主动取消请求（切换会话、关闭页面等），属于正常行为，不打印错误日志
        console.log("[Chat Agent API] 用户取消了请求");
      } else {
        // 真正的错误，打印错误日志
        console.error("[Chat Agent API] 流处理错误:", safeLogError(error));
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "error",
            content: errorMessage || "处理失败"
          })}\n\n`));
          await writer.close();
        } catch {
          // Writer 已关闭，忽略
        }
      }
    }
  })();
  
  return new Response(transformStream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

// GET 获取会话状态
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  
  if (!sessionId) {
    return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
  }
  
  const state = sessions.get(sessionId);
  
  if (!state) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
  
  return NextResponse.json({
    sessionId,
    state: {
      productImageUrl: state.productImageUrl,
      productName: state.productName,
      features: state.features,
      scripts: state.scripts,
      segments: state.segments,
      finalVideoUrl: state.finalVideoUrl,
      currentStage: state.currentStage,
      messages: state.messages
    }
  });
}

// DELETE 清除会话
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  
  if (!sessionId) {
    return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
  }
  
  sessions.delete(sessionId);
  
  return NextResponse.json({ success: true, message: "会话已清除" });
}