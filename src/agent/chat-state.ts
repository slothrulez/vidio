// 问答式带货视频生成 Agent - 状态定义

// Agent 状态接口
export interface ChatAgentState {
  // 对话历史
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  
  // 商品图片（支持多图片：主图片 + 辅助图片）
  productImageUrl?: string;  // 主图片URL（用于视频生成的主要参考）
  auxiliaryImages?: string[];  // 辅助图片URL列表（用于补充信息）
  productName?: string;
  category?: string;
  features: string[];
  
  // 文案信息（包含画面 Prompt）
  scripts: Array<{ id: number; script: string; feature: string; prompt?: string }>;
  
  // 视频片段
  segments: Array<{
    id: number;
    script: string;
    feature: string;
    prompt?: string;
    audioPath?: string;
    audioUrl?: string;
    videoPath?: string;
    videoUrl?: string;
    localVideoPath?: string;  // 本地视频路径
    duration: number;
  }>;
  
  // 输出目录
  outputDir?: string;
  
  // 最终视频
  finalVideoUrl?: string;
  finalVideoPath?: string;
  localVideoPath?: string;  // 本地最终视频路径
  finalDuration?: number;
  subtitleUrl?: string;
  
  // 配音语言
  voiceLanguage?: string;
  
  // 视频比例：'16:9'横版 或 '9:16'竖版
  videoRatio?: string;
  
  // 当前阶段（更细化的阶段划分）
  currentStage: "idle" | "identifying" | "product_identified" | "script_generated" | "video_generated" | "composing" | "done";
  
  // 错误信息
  error?: string;
}

// 工具结果类型
export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// Agent 消息类型（用于 SSE）
export interface AgentSSEMessage {
  type: "text" | "tool_call" | "tool_result" | "progress" | "state_update" | "wait_feedback" | "segment_video" | "complete" | "error" | "audio_merge";
  content?: string | Record<string, unknown> | ChatAgentState;  // content改为可选
  data?: Record<string, unknown>;
  sessionId?: string;
}

// 默认状态
export function getDefaultState(): ChatAgentState {
  return {
    messages: [],
    features: [],
    scripts: [],
    segments: [],
    currentStage: "idle"
  };
}