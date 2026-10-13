/**
 * LangGraph 工作流图
 * 定义视频生成 Agent 的完整流程
 */

import { StateGraph, END, START, StateType } from "@langchain/langgraph";
import { AgentState, Step } from "./state";
import {
  initNode,
  identifyProductNode,
  generateScriptsNode,
  generateSegmentsNode,
  composeFinalNode,
} from "./nodes";
import { safeLogError } from '@/lib/log-redact';

// 定义状态类型
type GraphState = typeof AgentState.State;

/**
 * 条件路由函数
 * 根据当前状态决定下一步
 */
function routeAfterInit(state: GraphState): string {
  // 如果有错误，结束流程
  if (state.errors && state.errors.length > 0) {
    return "end";
  }
  
  // 如果已有 scripts 和 prompts（video 模式），跳过 identify 和 scripts 节点
  if (state.scripts && state.scripts.length > 0 && state.prompts && state.prompts.length > 0) {
    return "generateSegments";
  }
  
  // 如果有图片URL，进行商品识别
  if (state.productImageUrl) {
    return "identify";
  }
  
  // 否则直接生成脚本（用户已提供商品信息）
  return "generateScripts";
}

function routeAfterIdentify(state: GraphState): string {
  if (state.errors && state.errors.length > 0) {
    return "end";
  }
  return "generateScripts";
}

function routeAfterScripts(state: GraphState): string {
  if (state.errors && state.errors.length > 0) {
    return "end";
  }
  return "generateSegments";
}

function routeAfterSegments(state: GraphState): string {
  if (state.errors && state.errors.length > 0) {
    return "end";
  }
  return "compose";
}

function routeAfterCompose(state: GraphState): string {
  // 完成
  return "end";
}

/**
 * 创建 Agent 工作流图
 */
export function createVideoAgentGraph() {
  // 创建状态图
  // 注意：节点名称不能与状态属性名称相同
  const workflow = new StateGraph(AgentState)
    // 添加节点
    .addNode("init", initNode)
    .addNode("identify", identifyProductNode)
    .addNode("generateScripts", generateScriptsNode)
    .addNode("generateSegments", generateSegmentsNode)
    .addNode("compose", composeFinalNode)
    
    // 添加边
    .addEdge(START, "init")
    .addConditionalEdges("init", routeAfterInit, {
      identify: "identify",
      generateScripts: "generateScripts",
      generateSegments: "generateSegments",
      end: END,
    })
    .addConditionalEdges("identify", routeAfterIdentify, {
      generateScripts: "generateScripts",
      end: END,
    })
    .addConditionalEdges("generateScripts", routeAfterScripts, {
      generateSegments: "generateSegments",
      end: END,
    })
    .addConditionalEdges("generateSegments", routeAfterSegments, {
      compose: "compose",
      end: END,
    })
    .addConditionalEdges("compose", routeAfterCompose, {
      end: END,
    });
  
  // 编译图
  const app = workflow.compile();
  
  return app;
}

/**
 * Agent 执行器
 * 提供简单的 API 来执行 Agent
 */
export class VideoAgentExecutor {
  private graph;
  
  constructor() {
    this.graph = createVideoAgentGraph();
  }
  
  /**
   * 执行完整的视频生成流程
   * @param input 输入状态
   * @param onProgress 进度回调（用于 SSE 流式输出）
   */
  async execute(
    input: Partial<GraphState>,
    onProgress?: (event: { step: string; message: string; data?: Record<string, unknown> }) => void
  ): Promise<GraphState> {
    console.log("[AgentExecutor] 开始执行 Agent");
    
    // 初始化状态
    const initialState: GraphState = {
      productImageUrl: input.productImageUrl || "",
      productImageLocalPath: input.productImageLocalPath || "",
      productName: input.productName || "",
      productType: input.productType || "",
      selectedMaterials: input.selectedMaterials || [],
      selectedFeatures: input.selectedFeatures || [],
      customSellingPoints: input.customSellingPoints || [],
      workDir: "",
      relativePath: "",
      scripts: input.scripts || [],
      prompts: input.prompts || [],
      segments: [],
      currentSegmentIndex: 0,
      finalVideoUrl: "",
      finalVideoLocalPath: "",
      finalSubtitles: [],
      currentStep: Step.INIT,
      errors: [],
      isComplete: false,
      taskId: "",
    };
    
    // 执行图
    try {
      const result = await this.graph.invoke(initialState);
      const finalState = result as GraphState;
      
      // 发送完成事件
      if (onProgress) {
        onProgress({
          step: "complete",
          message: "视频生成完成",
          data: {
            finalVideoUrl: finalState.finalVideoUrl,
            subtitles: finalState.finalSubtitles,
          },
        });
      }
      
      return finalState;
    } catch (error) {
      console.error("[AgentExecutor] 执行失败:", safeLogError(error));
      
      if (onProgress) {
        onProgress({
          step: "error",
          message: `执行失败: ${error}`,
        });
      }
      
      return {
        ...initialState,
        errors: [...initialState.errors, String(error)],
      };
    }
  }
  
  /**
   * 流式执行（返回每个节点的状态更新）
   */
  async *streamExecute(
    input: Partial<GraphState>
  ): AsyncGenerator<{ node: string; state: Partial<GraphState> }> {
    console.log("[AgentExecutor] 开始流式执行 Agent");
    
    const initialState: GraphState = {
      productImageUrl: input.productImageUrl || "",
      productImageLocalPath: input.productImageLocalPath || "",
      productName: input.productName || "",
      productType: input.productType || "",
      selectedMaterials: input.selectedMaterials || [],
      selectedFeatures: input.selectedFeatures || [],
      customSellingPoints: input.customSellingPoints || [],
      workDir: "",
      relativePath: "",
      scripts: input.scripts || [],
      prompts: input.prompts || [],
      segments: [],
      currentSegmentIndex: 0,
      finalVideoUrl: "",
      finalVideoLocalPath: "",
      finalSubtitles: [],
      currentStep: Step.INIT,
      errors: [],
      isComplete: false,
      taskId: "",
    };
    
    const stream = await this.graph.stream(initialState);
    
    for await (const chunk of stream) {
      // chunk 是 { nodeName: stateUpdate } 格式
      const chunkObj = chunk as Record<string, Partial<GraphState>>;
      const nodeNames = Object.keys(chunkObj);
      if (nodeNames.length > 0) {
        const nodeName = nodeNames[0];
        const stateUpdate = chunkObj[nodeName];
        
        yield {
          node: nodeName,
          state: stateUpdate,
        };
      }
    }
  }
}

// 导出单例
export const videoAgent = new VideoAgentExecutor();