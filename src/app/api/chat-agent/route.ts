// Conversational product video agent API

import { NextRequest, NextResponse } from "next/server";
import { HeaderUtils } from "coze-coding-dev-sdk";
import { chatNodeStream } from "@/agent/chat-node";
import { getDefaultState, ChatAgentState, AgentSSEMessage } from "@/agent/chat-state";
import { redactUrl, safeLogError } from '@/lib/log-redact';

// Session store (simple in-memory implementation; production should use a database)
const sessions = new Map<string, ChatAgentState>();

// POST handles chat requests
export async function POST(request: NextRequest) {
  console.log("[Chat Agent API] request received");
  
  const body = await request.json();
  const { sessionId, message, imageUrl, auxiliaryImages, productName, voiceLanguage, scripts, segments, videoRatio } = body;
  
  // Get or create the session
  const state: ChatAgentState = sessionId ? sessions.get(sessionId) || getDefaultState() : getDefaultState();
  // Unique ID: timestamp + random suffix
  const newSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  
  // A new image upload restarts the flow, so old generation data is not restored
  // Restore frontend scripts/segments only when no image was uploaded
  const isNewImageUpload = !!imageUrl;
  
  if (!isNewImageUpload) {
    // Use frontend scripts/segments as a fallback when the state has none
    if (scripts && scripts.length > 0 && (!state.scripts || state.scripts.length === 0)) {
      state.scripts = scripts;
      console.log(`[API] restored scripts from the frontend: ${scripts.length}`);
    }
    if (segments && segments.length > 0 && (!state.segments || state.segments.length === 0)) {
      state.segments = segments;
      console.log(`[API] restored segments from the frontend: ${segments.length}`);
    }
  }
  
  console.log(`[API] session restore: sessionId=${sessionId}, newSessionId=${newSessionId}, isNewImageUpload=${isNewImageUpload}, scripts=${state.scripts ? state.scripts.length : 'none'}, stage=${state.currentStage}`);
  
  // Add the user message to the history
  const userMessage: { role: "user"; content: string } = {
    role: "user",
    content: message
  };
  
  // Add image info to the message when present
  if (imageUrl) {
    // A new product image clears the previous generation state and restarts the flow
    console.log(`[API] new image uploaded, clearing previous generation state (scripts, segments, finalVideoUrl)`);
    state.scripts = []; // clear scripts
    state.segments = []; // clear segments
    state.finalVideoUrl = undefined; // clear the final video URL
    state.finalVideoPath = undefined;
    state.localVideoPath = undefined;
    state.finalDuration = undefined;
    state.subtitleUrl = undefined;
    state.features = []; // clear selling points
    state.productName = undefined; // clear the product name pending re-identification
    state.currentStage = "idle"; // reset the stage
    
    // Build the multi-image message
    let imageMessage = `${message}\n\n[Product images]`;
    imageMessage += `\nMain image (primary reference): ${imageUrl}`;
    
    state.productImageUrl = imageUrl; // store the main image URL
    
    // Add supporting images to the message and state
    if (auxiliaryImages && auxiliaryImages.length > 0) {
      imageMessage += `\nSupporting images:`;
      auxiliaryImages.forEach((img: string, index: number) => {
        imageMessage += `\n  - Image ${index + 1}: ${img}`;
      });
      state.auxiliaryImages = auxiliaryImages; // store the supporting image URLs
    }
    
    userMessage.content = imageMessage;
  }
  
  // Store the product name when provided
  if (productName) {
    state.productName = productName;
  }
  
  // Store the voiceover language when provided
  if (voiceLanguage) {
    state.voiceLanguage = voiceLanguage;
  }
  
  // Store the video ratio when provided
  if (videoRatio) {
    state.videoRatio = videoRatio;
    console.log(`[API] video ratio set to: ${videoRatio}`);
  }
  
  state.messages = [...state.messages, userMessage];
  
  // Extract request headers
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  
  const encoder = new TextEncoder();
  
  // Create a persistent SSE stream with TransformStream
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    }
  });
  
  const writer = transformStream.writable.getWriter();
  
  // Drive the generator in the background
  (async () => {
    try {
      const generator = chatNodeStream(state, customHeaders);
      
      for await (const agentMessage of generator) {
        // Log every event type
        const eventLog = `[chat-agent API] event: type=${agentMessage.type}`;
        console.log(eventLog);
        // Also write to app.log via info
        console.info(`[chat-agent API] event: type=${agentMessage.type}`);
        
        if (agentMessage.type === 'segment_video') {
          const segContent = agentMessage.content as { segmentId?: number; videoUrl?: string };
          console.log(`[chat-agent API] segment_video details: segmentId=${segContent.segmentId}, videoUrl=${redactUrl(segContent.videoUrl)}`);
        }
        
        const eventData = JSON.stringify({
          type: agentMessage.type,
          content: agentMessage.content,
          data: agentMessage.data,
          sessionId: newSessionId
        });
        
        // Write to the SSE stream
        try {
          await writer.write(encoder.encode(`data: ${eventData}\n\n`));
        } catch (writeError) {
          console.error(`[chat-agent API] write failed: ${safeLogError(writeError)}`);
        }
        
        // Collect state updates
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
        
        // Apply tool_result to the state
        // Two formats exist:
        // 1. Video generation: { type: "tool_result", content: { success, message, data: {...} } }
        // 2. Regular tool calls: { type: "tool_result", content: message, data: { success, message, data: {...} } }
        if (agentMessage.type === "tool_result") {
          // Support both: read toolData from content or data
          const contentObj = agentMessage.content && typeof agentMessage.content === 'object' 
            ? (agentMessage.content as Record<string, unknown>) 
            : null;
          const dataObj = agentMessage.data as Record<string, unknown> | undefined;
          
          // Format 1: content is the full object, use content.data
          // Format 2: content is a string, use data.data
          const outerData = contentObj || dataObj;
          const toolData = (outerData?.data || outerData) as Record<string, unknown> | undefined;
          
          if (toolData) {
            console.log(`[API] tool_result received: scripts=${toolData.scripts ? `${(toolData.scripts as Array<unknown>).length}` : 'none'}, segments=${toolData.segments ? `${(toolData.segments as Array<unknown>).length}` : 'none'}, stage=${toolData.currentStage || ''}`);
            if (toolData.productImageUrl) state.productImageUrl = toolData.productImageUrl as string;
            if (toolData.productName) state.productName = toolData.productName as string;
            if (toolData.features) state.features = toolData.features as string[];
            if (toolData.scripts) {
              state.scripts = toolData.scripts as Array<{ id: number; script: string; feature: string; prompt?: string }>;
              console.log(`[API] tool_result updated state.scripts: ${state.scripts.length}`);
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
              console.log(`[API] updated state.segments: ${state.segments.length}`);
              // Verbose log: check segments for videoUrl
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
        
        // Apply wait_feedback to the state (the backend sends content.state, not data.state)
        if (agentMessage.type === "wait_feedback") {
          // Support both content.state and data.state
          const contentData = agentMessage.content;
          const contentState = contentData && typeof contentData === 'object' && 'state' in contentData
            ? (contentData.state as ChatAgentState)
            : null;
          const dataState = agentMessage.data && typeof agentMessage.data === 'object' && 'state' in agentMessage.data
            ? (agentMessage.data.state as ChatAgentState)
            : null;
          const stateData = contentState || dataState;
          if (stateData) {
            console.log(`[API] wait_feedback state: segments=${stateData.segments?.length || 0}, stage=${stateData.currentStage}`);
            if (stateData.segments) {
              state.segments = stateData.segments;
              // Verbose log: check segments for videoUrl
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
      
      // Save the session
      sessions.set(newSessionId, state);
      
      // Verbose log: check final state.segments for videoUrl
      console.log(`[API] final state_update: segments=${state.segments?.length || 0}, stage=${state.currentStage}`);
      if (state.segments && state.segments.length > 0) {
        state.segments.forEach((seg, i) => {
          console.log(`[API] final state_update segment[${i}]: id=${seg.id}, hasVideo=${!!seg.videoUrl}, videoUrl=${redactUrl(seg.videoUrl)}`);
        });
      }
      
      // Send the final state
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
      // Distinguish user cancellation from real errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("ResponseAborted") || errorMessage.includes("aborted") || errorMessage.includes("cancel")) {
        // User cancelled (switched session, closed page): normal, no error log
        console.log("[Chat Agent API] request cancelled by the user");
      } else {
        // Real error
        console.error("[Chat Agent API] stream error:", safeLogError(error));
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "error",
            content: errorMessage || "Processing failed"
          })}\n\n`));
          await writer.close();
        } catch {
          // Writer already closed; ignore
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

// GET returns the session state
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  
  const state = sessions.get(sessionId);
  
  if (!state) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
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

// DELETE clears the session
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  
  sessions.delete(sessionId);
  
  return NextResponse.json({ success: true, message: "Session cleared" });
}