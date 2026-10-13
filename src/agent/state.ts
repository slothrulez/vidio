/**
 * LangGraph agent state definition
 * Holds the full state of the video generation flow
 */

import { Annotation } from "@langchain/langgraph";

/**
 * Video segment state
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
 * Agent state annotation
 * Defined with the LangGraph Annotation API
 */
export const AgentState = Annotation.Root({
  // ===== Input =====
  /** Product image URL (object storage) */
  productImageUrl: Annotation<string>,
  
  /** Local product image path */
  productImageLocalPath: Annotation<string>,
  
  /** Product name */
  productName: Annotation<string>,
  
  /** Product type */
  productType: Annotation<string>,
  
  /** Materials chosen by the user */
  selectedMaterials: Annotation<string[]>,
  
  /** Features chosen by the user */
  selectedFeatures: Annotation<string[]>,
  
  /** Custom selling points */
  customSellingPoints: Annotation<string[]>,
  
  // ===== Working directory =====
  /** Working directory path */
  workDir: Annotation<string>,
  
  /** Relative path for frontend access */
  relativePath: Annotation<string>,
  
  // ===== Generated scripts =====
  /** Script segments */
  scripts: Annotation<string[]>,
  
  /** Video prompts */
  prompts: Annotation<string[]>,
  
  // ===== Video segments =====
  /** Video segments */
  segments: Annotation<VideoSegment[]>,
  
  /** Index of the segment being generated */
  currentSegmentIndex: Annotation<number>,
  
  // ===== Final video =====
  /** Final video URL */
  finalVideoUrl: Annotation<string>,
  
  /** Local final video path */
  finalVideoLocalPath: Annotation<string>,
  
  /** Final subtitles */
  finalSubtitles: Annotation<{ text: string; startTime: number; endTime: number }[]>,
  
  // ===== Flow control =====
  /** Current step */
  currentStep: Annotation<string>,
  
  /** Errors */
  errors: Annotation<string[]>,
  
  /** Whether the flow is complete */
  isComplete: Annotation<boolean>,
  
  /** Task ID */
  taskId: Annotation<string>,
});

/**
 * State type (for inference)
 */
export type AgentStateType = typeof AgentState.State;

/**
 * State update type
 */
export type AgentUpdateType = typeof AgentState.Update;

/**
 * Flow steps
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
 * SSE event types
 */
export interface SSEEvent {
  type: "progress" | "error" | "complete" | "segment_update";
  step: Step;
  message?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}