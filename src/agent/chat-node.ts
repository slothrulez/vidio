// Conversational product video agent - chat node

import { LLMClient, Config } from "coze-coding-dev-sdk";
import {
  uploadAndIdentifyProduct,
  generateScripts,
  generateVideoSegments,
  generateVideoSegmentsStream,
  composeFinalVideo,
  modifyScript,
  regenerateSegment,
  ToolResult
} from "./tools";
import type { ChatAgentState, AgentSSEMessage } from "./chat-state";
import { redactUrl } from '@/lib/log-redact';

// System prompt defining the agent's role and capabilities
const SYSTEM_PROMPT = `You are vidio, a professional assistant that produces short promotional product videos for merchants, fully automatically, in English.

## Core capabilities
Take the product images, videos or text the user provides and extract the product name and key selling points; write a scene-by-scene English voiceover script with a matching visual prompt for every scene; drive TTS voiceover, AI video generation, audio/video mixing, single-scene regeneration and final composition, with automatic subtitles and background music.

## Interaction rules (always follow)
1. Always introduce yourself as vidio; be friendly and professional, and keep the short-form product video context in mind.
2. Guide the user through the whole flow: upload assets, confirm the script, preview segments, regenerate single segments, compose the chosen segments into the final video.
3. Know the whole production flow, say which stage you are in, and explain resource or generation problems clearly and kindly.
4. Let the user edit the script, regenerate a single video segment, and adjust subtitle and background music settings.
5. Stay focused on the product video; be concise and never output unrelated content. Always reply in English.

## Workflow (strictly in order)

### Step 1: user input → identify the product
- **Execution**: automatic
- **Result**: always show the recognition result (product name + selling points)
- **Next**: once identified, immediately call generateScripts

### Step 2: write the script + visual prompts → wait for feedback
- **Execution**: automatic
- **Result**: always show the script list (4 voiceover scripts + visual prompts)
- **Feedback**: wait for the user to confirm or reject
- If the user says "reject / not happy / regenerate" → call generateScripts again
- If the user says "confirm / looks good / generate the video" → call generateVideoSegments (step 3)
- **Exception**: if the initial request explicitly says "no review needed / generate the video directly", skip the wait and call generateVideoSegments

### Step 3: generate video segments → wait for feedback
- **Execution**: automatic (after the script is confirmed)
- **Result**: always show the segment previews (one player per segment)
- **Feedback**: wait for the user to choose
- If the user says "regenerate segment X" → call regenerateSegment
- If the user says "compose / finish / confirm composition" → call composeFinalVideo (step 4)
- **Exception**: if the user already said "no review needed / compose directly" when confirming the script, skip the wait and call composeFinalVideo

### Step 4: compose the final video → output
- **Execution**: automatic
- **Result**: always show the download link (video player + download button)
- **End**: after composition, reply "Your video is ready" with the download link and call no more tools

## Key rules (always follow)
1. **State check**: before every tool call, check the current state:
   - If segments already exist and the user says "compose", call composeFinalVideo; never call generateVideoSegments again
   - If scripts already exist and the user says "generate the video / confirm", call generateVideoSegments; never call generateScripts again
   - If finalVideoUrl exists, the flow is over; call no more tools

2. **Tool priority**:
   - stage video_generated + user says "compose" → composeFinalVideo (highest priority)
   - stage script_generated + user says "confirm / generate the video" → generateVideoSegments
   - stage product_identified → generateScripts (automatic)

3. **Avoid repeats**:
   - If segments exist (count > 0), never call generateVideoSegments again
   - If scripts exist (count > 0), never call generateScripts again unless the user explicitly asks to regenerate
   - If finalVideoUrl exists, reply "Your video is ready" and call no more tools

## Result display
- Product recognition: show the product name and a list of selling-point tags
- Script generation: show 4 scripts, each numbered with its visual description
- Video segments: show a preview player per segment
- Final video: show the final player and the download link

## Tool call format
When you need a tool, use this JSON format wrapped in the special tags:
<tool_call>
{
  "tool": "toolName",
  "input": {
    "paramName": "paramValue"
  }
}
</tool_call>

## Available tools
1. uploadAndIdentifyProduct - upload images and identify the product (supports multiple images)
   Input: { imageUrl: string, auxiliaryImages?: string[], productName?: string }
   Note: imageUrl is the main image (primary reference); auxiliaryImages are supporting images
   Output: { productName, features, productImageUrl } - must be shown

2. generateScripts - write the promotional script
   Input: { productName: string, features: string[] }
   Output: { scripts: [{id, script, prompt}] } - must be shown

3. generateVideoSegments - generate video segments
   Input: { scripts: [], productImageUrl: string, productName: string }
   Output: { segments: [{id, videoUrl, audioUrl}] } - must be shown

4. composeFinalVideo - compose the final video
   Input: { segments: [], productName: string, bgmUrl?: string, embedSubtitle?: boolean }
   Output: { finalVideoUrl, subtitleUrl } - must be shown

5. regenerateSegment - regenerate a single segment
   Input: { segmentId: number, script: string, prompt: string, productImageUrl: string }
   Output: { videoUrl, audioUrl } - must be shown

6. modifyScript - edit the script
   Input: { scripts: [], scriptId: number, newScript: string }
   Output: { scripts: [] } - must be shown

## Important rules
1. After the product is identified, continue to the script automatically (no wait)
2. After the script is written, wait for the user to confirm or reject
3. After the user confirms the script, generate the video segments automatically
4. After the segments are generated, wait for the user to choose / confirm composition
5. If the user explicitly says "no review needed / generate directly / compose directly", skip the waits
6. Every step's result must be shown to the user`;

// Parse tool calls
function parseToolCall(content: string): { tool: string; input: Record<string, unknown> } | null {
  const toolCallMatch = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (!toolCallMatch) return null;
  
  try {
    const parsed = JSON.parse(toolCallMatch[1]);
    return parsed;
  } catch {
    return null;
  }
}

// Progress message for a tool
function getToolProgressMessage(toolName: string, state?: ChatAgentState): string {
  const scriptsCount = state?.scripts?.length || 4;
  const segmentsCount = state?.scripts?.length || 4;
  
  switch (toolName) {
    case "uploadAndIdentifyProduct":
      return "🔍 Identifying the product and extracting 3-5 selling points...";
    case "generateScripts":
      return `✍️ Writing the script (${scriptsCount} scenes), please wait...`;
    case "generateVideoSegments":
      return `🎬 Generating ${segmentsCount} video segments, please wait...`;
    case "composeFinalVideo":
      return "🎞️ Composing the final video, this takes about 1-2 minutes...";
    case "regenerateSegment":
      return "🔄 Regenerating the segment...";
    case "modifyScript":
      return "📝 Updating the script...";
    default:
      return "⏳ Working...";
  }
}

// Execute a tool (with live event callbacks)
async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  state: ChatAgentState,
  customHeaders?: Record<string, string>,
  onEvent?: (event: AgentSSEMessage) => void
): Promise<ToolResult> {
  console.log(`[Agent] executing tool: ${toolName}`, input);
  
  switch (toolName) {
    case "uploadAndIdentifyProduct":
      return await uploadAndIdentifyProduct(
        input.imageUrl as string,
        input.auxiliaryImages as string[] | undefined, // supporting images
        input.productName as string | undefined,
        customHeaders
      );
    
    case "generateScripts":
      return await generateScripts(
        input.productName as string,
        input.features as string[],
        input.productImageUrl as string | undefined,
        customHeaders,
        state.voiceLanguage // the session's voiceover language
      );
    
    case "generateVideoSegments":
      // callback that emits segment_video events live
      return await generateVideoSegments(
        state.scripts || input.scripts,
        input.productImageUrl as string,
        input.productName as string,
        customHeaders,
        (segment) => {
          // live callback: yield a segment_video event
          console.log(`[Agent] live segment_video event: segmentId=${segment.id}`);
          if (onEvent) {
            onEvent({
              type: "segment_video",
              content: {
                segmentId: segment.id,
                videoUrl: segment.videoUrl,  // object storage URL only
                audioUrl: segment.audioUrl,
                duration: segment.duration,
                script: segment.script
              }
            });
          }
        }
      );
    
    case "composeFinalVideo":
      // Fall back to state when the LLM omits segments
      const segmentsForCompose = (input.segments && Array.isArray(input.segments) && input.segments.length > 0)
        ? input.segments
        : state.segments || [];
      
      if (segmentsForCompose.length === 0) {
        console.error('[Agent] composeFinalVideo: no segments, cannot compose');
        return {
          success: false,
          message: "Cannot compose the video: no segments yet. Generate the video segments first.",
          error: "segments_empty"
        };
      }
      
      console.log(`[Agent] composeFinalVideo: composing ${segmentsForCompose.length} segments`);
      
      return await composeFinalVideo(
        segmentsForCompose as Array<{ id: number; script: string; prompt: string; videoPath?: string; audioPath?: string; videoUrl?: string; audioUrl?: string }>,
        input.productName as string || state.productName || "Product",
        { bgmUrl: input.bgmUrl as string | undefined, embedSubtitle: input.embedSubtitle as boolean | undefined },
        customHeaders
      );
    
    case "modifyScript":
      return modifyScript(
        input.scriptId as number,
        input.newScript as string,
        input.productName as string,
        input.features as string[],
        customHeaders
      );
    
    case "regenerateSegment":
      return await regenerateSegment(
        input.segmentId as number,
        input.script as string,
        input.prompt as string,
        input.productImageUrl as string,
        input.productName as string,
        input.folderPath as string | undefined,
        customHeaders
      );
    
    default:
      return {
        success: false,
        message: `Unknown tool: ${toolName}`
      };
  }
}

// Stages that wait for user feedback
const WAIT_FOR_USER_FEEDBACK_STAGES = ["script_generated", "video_generated"];

// Automatic chain: the next step runs after a successful identification
const AUTO_NEXT_TOOL: Record<string, string> = {
  "uploadAndIdentifyProduct": "generateScripts",  // identified → write the script automatically
  // generateScripts waits for confirmation
  // generateVideoSegments waits for a selection
};

// Streaming chat node (multi-round tool calls)
export async function* chatNodeStream(
  state: ChatAgentState,
  customHeaders?: Record<string, string>
): AsyncGenerator<AgentSSEMessage> {
  console.log("[Agent] streaming chat node started");
  
  const llmClient = new LLMClient(new Config(), customHeaders);
  
  // Current state (updated by tool results)
  let currentState = state;
  
  // Build the conversation history
  const conversationHistory: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  
  // Add history (including earlier tool results)
  if (state.messages && state.messages.length > 0) {
    conversationHistory.push(...state.messages);
  }
  
  // Intent tags in the user message call the tool directly
  const userMessages = conversationHistory.filter(m => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  
  // Extract the message content as a string
  let lastUserMessageContent = '';
  if (lastUserMessage) {
    const content: unknown = lastUserMessage.content;
    if (typeof content === 'string') {
      lastUserMessageContent = content;
    } else if (Array.isArray(content)) {
      lastUserMessageContent = content
        .map((c: unknown) => typeof c === 'string' ? c : c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : '')
        .join('');
    }
  }
  
  if (lastUserMessage && lastUserMessageContent) {
    // Compose-video intent
    if (lastUserMessageContent.includes("[COMPOSE_VIDEO]") && state.segments && state.segments.length > 0) {
      console.log("[Agent] [COMPOSE_VIDEO] intent detected, calling composeFinalVideo");
      yield { type: "progress", content: "Composing the final video..." };
      
      const toolResult = await composeFinalVideo(state.segments, state.productName || "", undefined, customHeaders);
      
      if (toolResult.success) {
        currentState = {
          ...currentState,
          finalVideoUrl: toolResult.data?.finalVideoUrl as string | undefined,
          finalVideoPath: toolResult.data?.finalVideoPath as string | undefined,
          finalDuration: toolResult.data?.finalDuration as number | undefined,
          subtitleUrl: toolResult.data?.subtitleUrl as string | undefined,
          currentStage: "done"
        };
        
        yield {
          type: "state_update",
          content: currentState as unknown as Record<string, unknown>
        };
        
        yield {
          type: "tool_result",
          content: {
            tool: "composeFinalVideo",
            success: true,
            data: {
              finalVideoUrl: toolResult.data?.finalVideoUrl,
              finalVideoPath: toolResult.data?.finalVideoPath,
              finalDuration: toolResult.data?.finalDuration,
              subtitleUrl: toolResult.data?.subtitleUrl,
              currentStage: "done"
            }
          }
        };
        
        yield { type: "complete", content: "Video composed" };
        return;
      } else {
        yield { type: "error", content: toolResult.message || "Video composition failed" };
        yield { type: "complete", content: "Composition failed" };
        return;
      }
    }
    
    // Generate-segments intent
    console.log(`[Agent] checking [GENERATE_SEGMENTS] intent: hasTag=${lastUserMessageContent.includes("[GENERATE_SEGMENTS]")}, scripts=${state.scripts ? state.scripts.length : 'undefined'}, stage=${state.currentStage}`);
    if (lastUserMessageContent.includes("[GENERATE_SEGMENTS]")) {
      // Ensure scripts exist, falling back to currentState or failing
      const scriptsToUse = state.scripts || currentState.scripts;
      if (!scriptsToUse || scriptsToUse.length === 0) {
        console.error("[Agent] [GENERATE_SEGMENTS] intent failed: no scripts");
        yield { type: "error", content: "No script yet; write the script first" };
        yield { type: "complete", content: "Generation failed" };
        return;
      }
      
      console.log("[Agent] [GENERATE_SEGMENTS] intent detected, calling generateVideoSegments, scripts:", scriptsToUse.length);
      yield { type: "progress", content: "Generating video segments..." };
      
      // Send an initial state_update so the frontend can receive segment_video events
      const initialSegments = scriptsToUse.map((script, index) => ({
        id: script.id || index + 1,
        script: script.script || script.feature || '',
        feature: script.feature || '',
        prompt: script.prompt || '',
        videoUrl: '', // filled by segment_video events
        audioUrl: '', // filled by segment_video events
      }));
      
      yield {
        type: "state_update",
        content: {  // content field
          ...currentState,
          // scripts are omitted so they are not shown during generation
          // scripts: scriptsToUse,  // removed
          segments: initialSegments,
          currentStage: "video_generating"
        }
      };
      
      console.log(`[Agent] yield state_update: segments=${initialSegments.length}, stage=video_generating, no scripts`);
      
      // Stream version yields events live
      const streamGenerator = generateVideoSegmentsStream(
        scriptsToUse,
        state.productImageUrl || currentState.productImageUrl || "",
        state.productName || currentState.productName || "",
        customHeaders,
        state.videoRatio || currentState.videoRatio // video ratio
      );
      
      let toolResult: ToolResult | null = null;
      const segmentsFromStream: Array<{ id: number; videoUrl: string; duration?: number; script?: string }> = [];
      
      // Iterate the stream and yield segment events live
      for await (const event of streamGenerator) {
        if (event.type === 'segment_video') {
          // segments yielded by tools.ts use id, not segmentId
          const segment = event.content as { id: number; segmentId?: number; videoUrl: string; duration?: number; script?: string };
          const actualSegmentId = segment.id || segment.segmentId;
          console.log(`[Agent] yield segment_video: id=${actualSegmentId}, videoUrl=${redactUrl(segment.videoUrl)}`);
          yield {
            type: "segment_video",
            content: {
              segmentId: actualSegmentId,  // frontend expects segmentId
              id: actualSegmentId,         // id kept for compatibility
              videoUrl: segment.videoUrl,
              duration: segment.duration,
              script: segment.script
            }
          };
        } else if (event.type === 'result') {
          toolResult = event.data as ToolResult;
          console.log(`[Agent] final result: success=${toolResult.success}`);
        }
      }
      
      if (!toolResult) {
        yield { type: "error", content: "Video generation returned no result" };
        yield { type: "complete", content: "Generation failed" };
        return;
      }
      
      if (toolResult.success) {
        // Use the segments from toolResult (videoUrl included)
        const rawSegments = (toolResult.data?.segments as Array<{
          id?: number;
          script?: string;
          feature?: string;
          prompt?: string;
          audioUrl?: string;
          videoUrl?: string;
          localVideoPath?: string;
          duration?: number;
        }>) || [];
        
        // Convert to the ChatAgentState.segments shape
        const finalSegments: Array<{
          id: number;
          script: string;
          feature: string;
          prompt?: string;
          audioPath?: string;
          audioUrl?: string;
          videoPath?: string;
          videoUrl?: string;
          localVideoPath?: string;
          duration: number;
        }> = rawSegments.map((seg) => ({
          id: seg.id || 0,
          script: seg.script || '',
          feature: seg.feature || seg.script?.substring(0, 30) || '',
          prompt: seg.prompt,
          audioUrl: seg.audioUrl,
          videoUrl: seg.videoUrl,
          localVideoPath: seg.localVideoPath,
          duration: seg.duration || 4
        }));
        
        console.log(`[Agent] final segment count: ${finalSegments.length}`);
        finalSegments.forEach((seg, i) => {
          console.log(`[Agent] segment ${i+1}: id=${seg.id}, videoUrl=${redactUrl(seg.videoUrl)}, hasVideo=${!!seg.videoUrl}`);
        });
        
        currentState = {
          ...currentState,
          segments: finalSegments,
          currentStage: "video_generated"
        };
        
        // Send state_update with the complete segments (videoUrl included)
        console.log(`[Agent] yield state_update: segments=${finalSegments.length}, stage=video_generated, with videoUrl`);
        // Log the redacted videoUrl
        finalSegments.forEach((seg, i) => {
          console.log(`[Agent] state_update segment[${i}] videoUrl: ${redactUrl(seg.videoUrl)}`);
        });
        yield {
          type: "state_update",
          content: {
            segments: finalSegments,
            currentStage: "video_generated",
            productName: currentState.productName,
            features: currentState.features
          }
        };
        
        // Send tool_result
        yield {
          type: "tool_result",
          content: {
            tool: "generateVideoSegments",
            success: true,
            message: `Generated ${finalSegments.length} video segments`,
            data: {
              segments: finalSegments,
              currentStage: "video_generated"
            }
          }
        };
        
        // Send wait_feedback
        yield {
          type: "wait_feedback",
          content: {
            message: "The video segments are ready. Confirm them to compose the final video.",
            state: {
              segments: finalSegments,
              currentStage: "video_generated",
              productName: currentState.productName
            }
          }
        };
        
        yield { type: "complete", content: "Video segments generated" };
        return;
      } else {
        yield { type: "error", content: toolResult.message || "Video segment generation failed" };
        yield { type: "complete", content: "Generation failed" };
        return;
      }
    }
  }
  
  // At most 5 tool rounds to avoid infinite loops
  const MAX_ROUNDS = 5;
  let currentRound = 0;
  
  while (currentRound < MAX_ROUNDS) {
    currentRound++;
    console.log(`[Agent] round ${currentRound}`);
    
    // Build the state context with an explicit next-step hint
    let nextActionHint = "";
    if (currentState.finalVideoUrl) {
      nextActionHint = "IMPORTANT: the final video exists and the flow is over. Reply 'Your video is ready to download' and call no tools.";
    } else if (currentState.segments && currentState.segments.length > 0) {
      nextActionHint = "IMPORTANT: segments exist. When the user says compose/confirm, call composeFinalVideo and never generateVideoSegments again.";
    } else if (currentState.scripts && currentState.scripts.length > 0 && currentState.currentStage === "script_generated") {
      nextActionHint = "IMPORTANT: the script exists and awaits confirmation. When the user confirms or asks for the video, call generateVideoSegments.";
    } else if (currentState.productName && currentState.currentStage === "product_identified") {
      nextActionHint = "IMPORTANT: the product is identified; call generateScripts automatically.";
    }
    
    const stateContext = `
## Current state
- Product image: ${currentState.productImageUrl || "not uploaded"}
- Product name: ${currentState.productName || "unknown"}
- Selling points: ${currentState.features?.join(", ") || "none yet"}
- Script scenes: ${currentState.scripts?.length || 0}
- Video segments: ${currentState.segments?.length || 0}
- Final video: ${currentState.finalVideoUrl || "not generated"}
- Current stage: ${currentState.currentStage}

${nextActionHint}
`;
    
    // Rebuild system prompt + state context every round
    const systemMessage = {
      role: "system" as const,
      content: SYSTEM_PROMPT + stateContext
    };
    
    // Later rounds skip the duplicate progress message
    
    // Stream the LLM
    console.log(`[Agent] round ${currentRound}: streaming LLM...`);
    const stream = llmClient.stream([systemMessage, ...conversationHistory], {
      model: "doubao-seed-1-8-251228",
      temperature: 0.8
    });
    
    let fullContent = "";
    
    // Collect LLM output without yielding yet (tool-call syntax is filtered)
    for await (const chunk of stream) {
      if (chunk.content) {
        const text = chunk.content.toString();
        fullContent += text;
      }
    }
    
    // Check for a tool call
    const toolCall = parseToolCall(fullContent);
    
    // Strip tool-call syntax, keep meaningful text
    let meaningfulText = fullContent;
    if (toolCall) {
      // Remove the tool-call block
      meaningfulText = fullContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    }
    
    // Only yield meaningful text (non-empty, no tool call)
    // With a tool call, text is not yielded so scripts are not shown during generation
    if (meaningfulText && meaningfulText.length > 0 && !toolCall) {
      yield { type: "text", content: meaningfulText };
    }
    
    if (!toolCall) {
      // No tool call: the turn ends
      console.log("[Agent] no tool call, turn complete");
      yield { type: "complete", content: "Done" };
      return;
    }
    
    console.log(`[Agent] round ${currentRound} tool call:`, toolCall.tool);
    
    // Send a progress hint instead of the tool-call syntax
    const toolProgressMessage = getToolProgressMessage(toolCall.tool, state);
    yield { type: "progress", content: toolProgressMessage };
    
    // Event queue for live events during tool execution
    const eventQueue: AgentSSEMessage[] = [];
    
    // Execute the tool with a callback collecting live events
    const toolResult = await executeTool(
      toolCall.tool,
      toolCall.input,
      currentState,
      customHeaders,
      (event) => {
        // Queue live events
        eventQueue.push(event);
      }
    );
    
    // Yield queued live events (segment_video etc.)
    for (const event of eventQueue) {
      yield event;
    }
    
    const segmentsLength = (toolResult.data as Record<string, unknown>)?.segments 
      ? ((toolResult.data as Record<string, unknown>).segments as Array<unknown>).length 
      : 0;
    console.log(`[Agent] tool ${toolCall.tool} finished: success=${toolResult.success}, segments=${segmentsLength}, liveEvents=${eventQueue.length}`);
    
    // Update state
    if (toolResult.data) {
      currentState = { ...currentState, ...toolResult.data };
      const currentSegmentsLength = currentState.segments?.length || 0;
      console.log(`[Agent] currentState updated: segments=${currentSegmentsLength}, stage=${currentState.currentStage}`);
    }
    
    // Send the tool result (short message)
    yield { type: "tool_result", content: toolResult.message, data: toolResult.data };
    
    if (!toolResult.success) {
      yield { type: "error", content: toolResult.message };
      return;
    }
    
    // Add the tool result to the history
    conversationHistory.push({
      role: "assistant",
      content: fullContent
    });
    conversationHistory.push({
      role: "user",
      content: `Tool ${toolCall.tool} result: ${toolResult.message}\n\nState update: ${JSON.stringify(toolResult.data || {})}`
    });
    
    // Check whether to wait for feedback
    const newStage = currentState.currentStage;
    if (WAIT_FOR_USER_FEEDBACK_STAGES.includes(newStage)) {
      console.log(`[Agent] stage ${newStage} waits for user feedback`);
      yield { 
        type: "wait_feedback", 
        content: "Waiting for your feedback",
        data: { stage: newStage, state: currentState }
      };
      return;
    }
    
    // Send the state update
    yield {
      type: "state_update",
      content: currentState as unknown as Record<string, unknown>
    };
    
    // Check for an automatic next step
    const nextTool = AUTO_NEXT_TOOL[toolCall.tool];
    if (nextTool) {
      console.log(`[Agent] auto next step: ${nextTool}`);
      // Tell the frontend the next step runs automatically
      yield {
        type: "progress",
        content: `Continuing automatically: ${nextTool}`,
        data: { nextTool }
      };
    }
  }
  
  // Max rounds exceeded
  console.log("[Agent] max rounds reached");
  yield { type: "complete", content: "Finished" };
}

// Exports
export { SYSTEM_PROMPT, parseToolCall, executeTool };