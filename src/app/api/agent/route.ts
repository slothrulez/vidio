/**
 * Agent API route
 * Streams the full video generation flow over SSE
 * 
 * Two modes:
 * - mode: "full" - full flow (identify product -> write script -> generate video -> compose)
 * - mode: "video" - video only (skip identification and scripting; generate video from the given scripts)
 */

import { NextRequest } from "next/server";
import { videoAgent } from "@/agent";
import { safeLogError } from '@/lib/log-redact';

// Simplified event data type
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
  
  console.log("[Agent API] request received:", body);
  
  const mode = body.mode || "full"; // "full" or "video"
  
  // SSE response
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      // SSE event helper
      const sendEvent = (event: string, data: Record<string, unknown>) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };
      
      try {
        // Start event
        sendEvent("start", {
          message: `Agent started (mode: ${mode})`,
          mode,
          timestamp: Date.now(),
        });
        
        // Input state
        const input: Record<string, unknown> = {
          productImageUrl: body.productImageUrl || "",
          productImageLocalPath: body.productImageLocalPath || "",
          productName: body.productName || "",
          productType: body.productType || "",
          selectedMaterials: body.selectedMaterials || [],
          selectedFeatures: body.selectedFeatures || [],
          customSellingPoints: body.customSellingPoints || [],
        };
        
        // Video mode needs existing scripts and prompts
        if (mode === "video") {
          // Validate required parameters
          if (!body.scripts || !Array.isArray(body.scripts) || body.scripts.length === 0) {
            sendEvent("error", {
              message: "video mode requires a scripts array",
              timestamp: Date.now(),
            });
            controller.close();
            return;
          }
          
          input.scripts = body.scripts;
          input.prompts = body.prompts || body.scripts; // fall back to scripts when prompts are missing
          input.skipIdentify = true;
          input.skipScriptGeneration = true;
        }
        
        // Streaming run
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
          
          console.log(`[Agent API] node ${node} finished`);
          
          // Update event data
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
          
          console.log(`[Agent API] node ${node} returned:`, safeLogError(state));
          
          // Node completion event
          sendEvent("node_complete", {
            node,
            step: state.currentStep || "",
            message: `Node ${node} finished`,
            data: eventData,
            timestamp: Date.now(),
          });
        }
        
        // Completion event
        sendEvent("complete", {
          message: "Video generation complete",
          data: eventData,
          timestamp: Date.now(),
        });
        
      } catch (error) {
        console.error("[Agent API] run error:", safeLogError(error));
        sendEvent("error", {
          message: `Run failed: ${error}`,
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