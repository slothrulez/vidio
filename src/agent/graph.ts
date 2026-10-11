/**
 * LangGraph workflow graph
 * Defines the full video generation agent flow
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

// State type
type GraphState = typeof AgentState.State;

/**
 * Conditional router
 * Chooses the next step from the current state
 */
function routeAfterInit(state: GraphState): string {
  // Stop on errors
  if (state.errors && state.errors.length > 0) {
    return "end";
  }
  
  // With scripts and prompts (video mode), skip identify and scripts
  if (state.scripts && state.scripts.length > 0 && state.prompts && state.prompts.length > 0) {
    return "generateSegments";
  }
  
  // With an image URL, identify the product
  if (state.productImageUrl) {
    return "identify";
  }
  
  // Otherwise write the script (product info was provided)
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
  // Done
  return "end";
}

/**
 * Build the agent workflow graph
 */
export function createVideoAgentGraph() {
  // Create the state graph
  // Node names must not collide with state keys
  const workflow = new StateGraph(AgentState)
    // Nodes
    .addNode("init", initNode)
    .addNode("identify", identifyProductNode)
    .addNode("generateScripts", generateScriptsNode)
    .addNode("generateSegments", generateSegmentsNode)
    .addNode("compose", composeFinalNode)
    
    // Edges
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
  
  // Compile
  const app = workflow.compile();
  
  return app;
}

/**
 * Agent executor
 * Simple API for running the agent
 */
export class VideoAgentExecutor {
  private graph;
  
  constructor() {
    this.graph = createVideoAgentGraph();
  }
  
  /**
   * Run the full video generation flow
   * @param input initial state
   * @param onProgress progress callback for SSE streaming
   */
  async execute(
    input: Partial<GraphState>,
    onProgress?: (event: { step: string; message: string; data?: Record<string, unknown> }) => void
  ): Promise<GraphState> {
    console.log("[AgentExecutor] starting the agent");
    
    // Initial state
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
    
    // Run the graph
    try {
      const result = await this.graph.invoke(initialState);
      const finalState = result as GraphState;
      
      // Emit the completion event
      if (onProgress) {
        onProgress({
          step: "complete",
          message: "Video generation complete",
          data: {
            finalVideoUrl: finalState.finalVideoUrl,
            subtitles: finalState.finalSubtitles,
          },
        });
      }
      
      return finalState;
    } catch (error) {
      console.error("[AgentExecutor] run failed:", safeLogError(error));
      
      if (onProgress) {
        onProgress({
          step: "error",
          message: `Run failed: ${error}`,
        });
      }
      
      return {
        ...initialState,
        errors: [...initialState.errors, String(error)],
      };
    }
  }
  
  /**
   * Streaming run (yields each node's state update)
   */
  async *streamExecute(
    input: Partial<GraphState>
  ): AsyncGenerator<{ node: string; state: Partial<GraphState> }> {
    console.log("[AgentExecutor] starting the streaming agent run");
    
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
      // chunk has the shape { nodeName: stateUpdate }
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

// Singleton export
export const videoAgent = new VideoAgentExecutor();