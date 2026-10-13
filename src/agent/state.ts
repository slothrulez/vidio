/**
 * LangGraph Agent 状态定义
 * 用于管理视频生成流程的完整状态
 */

import { Annotation } from "@langchain/langgraph";

/**
 * 视频片段状态
 */
export interface VideoSegment {
  id: number;
  script: string;
  prompt: string;
  audioUrl?: string;
  audioLocalPath?: string;
  audioDuration?: number;
  videoUrl?: string;
  videoLocalPath?: string;
  videoDuration?: number;
  isGenerating: boolean;
  isSelected: boolean;
  error?: string;
}

/**
 * Agent 状态注解
 * 使用 LangGraph 的 Annotation API 定义状态
 */
export const AgentState = Annotation.Root({
  // ===== 输入信息 =====
  /** 商品图片 URL（对象存储） */
  productImageUrl: Annotation<string>,
  
  /** 商品图片本地路径 */
  productImageLocalPath: Annotation<string>,
  
  /** 商品名称 */
  productName: Annotation<string>,
  
  /** 商品类型 */
  productType: Annotation<string>,
  
  /** 用户选择的材质 */
  selectedMaterials: Annotation<string[]>,
  
  /** 用户选择的特点 */
  selectedFeatures: Annotation<string[]>,
  
  /** 自定义卖点 */
  customSellingPoints: Annotation<string[]>,
  
  // ===== 工作目录 =====
  /** 工作目录路径 */
  workDir: Annotation<string>,
  
  /** 相对路径（用于前端访问） */
  relativePath: Annotation<string>,
  
  // ===== 生成的脚本 =====
  /** 脚本片段列表 */
  scripts: Annotation<string[]>,
  
  /** 视频 Prompt 列表 */
  prompts: Annotation<string[]>,
  
  // ===== 视频片段 =====
  /** 视频片段列表 */
  segments: Annotation<VideoSegment[]>,
  
  /** 当前正在生成的片段索引 */
  currentSegmentIndex: Annotation<number>,
  
  // ===== 最终视频 =====
  /** 最终视频 URL */
  finalVideoUrl: Annotation<string>,
  
  /** 最终视频本地路径 */
  finalVideoLocalPath: Annotation<string>,
  
  /** 最终字幕列表 */
  finalSubtitles: Annotation<{ text: string; startTime: number; endTime: number }[]>,
  
  // ===== 流程控制 =====
  /** 当前步骤 */
  currentStep: Annotation<string>,
  
  /** 错误信息 */
  errors: Annotation<string[]>,
  
  /** 是否完成 */
  isComplete: Annotation<boolean>,
  
  /** 任务 ID */
  taskId: Annotation<string>,
});

/**
 * 状态类型（用于类型推断）
 */
export type AgentStateType = typeof AgentState.State;

/**
 * 更新状态类型
 */
export type AgentUpdateType = typeof AgentState.Update;

/**
 * 流程步骤枚举
 */
export enum Step {
  INIT = "init",
  IDENTIFY_PRODUCT = "identify_product",
  GENERATE_SCRIPTS = "generate_scripts",
  GENERATE_SEGMENTS = "generate_segments",
  COMPOSE_FINAL = "compose_final",
  COMPLETE = "complete",
  ERROR = "error",
}

/**
 * SSE 事件类型
 */
export interface SSEEvent {
  type: "progress" | "error" | "complete" | "segment_update";
  step: Step;
  message?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}