// Conversational product video agent state

// Agent state interface
export interface ChatAgentState {
  // Chat history
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  
  // Product images (main image + supporting images)
  productImageUrl?: string;  // main image URL (primary reference for video generation)
  auxiliaryImages?: string[];  // supporting image URLs
  productName?: string;
  category?: string;
  features: string[];
  
  // Scripts (with visual prompts)
  scripts: Array<{ id: number; script: string; feature: string; prompt?: string }>;
  
  // Video segments
  segments: Array<{
    id: number;
    script: string;
    feature: string;
    prompt?: string;
    audioPath?: string;
    audioUrl?: string;
    videoPath?: string;
    videoUrl?: string;
    localVideoPath?: string;  // local video path
    duration: number;
  }>;
  
  // Output directory
  outputDir?: string;
  
  // Final video
  finalVideoUrl?: string;
  finalVideoPath?: string;
  localVideoPath?: string;  // local final video path
  finalDuration?: number;
  subtitleUrl?: string;
  
  // Voiceover language (english)
  voiceLanguage?: string;
  
  // Video ratio: '16:9' landscape or '9:16' portrait
  videoRatio?: string;
  
  // Current stage
  currentStage: "idle" | "identifying" | "product_identified" | "script_generated" | "video_generated" | "composing" | "done";
  
  // Errors
  error?: string;
}

// Tool result type
export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// Agent message type (SSE)
export interface AgentSSEMessage {
  type: "text" | "tool_call" | "tool_result" | "progress" | "state_update" | "wait_feedback" | "segment_video" | "complete" | "error" | "audio_merge";
  content?: string | Record<string, unknown> | ChatAgentState;  // content is optional
  data?: Record<string, unknown>;
  sessionId?: string;
}

// Default state
export function getDefaultState(): ChatAgentState {
  return {
    messages: [],
    features: [],
    scripts: [],
    segments: [],
    currentStage: "idle"
  };
}