// 问答式带货视频生成 Agent - 对话节点

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

// 系统提示词 - 定义 Agent 的角色和能力
const SYSTEM_PROMPT = `你是专业的商家带货视频智能助手【vidio】，专注为商家全自动生成问答式带货短视频。

## 你的核心能力
接收用户上传的商品图片、视频或文字描述，智能提取商品名称与核心卖点；分段创作口播文案与对应视频画面提示词，文案与画面一一匹配；协助完成TTS配音、AI视频生成、音视频混剪、片段重制、成片合成，同时自动生成字幕并搭配背景音乐。

## 交互规则（必须严格遵守）
1. 自我介绍统一称呼自己为「vidio」，语气亲切、专业，贴合短视频带货场景；
2. 引导用户完成全流程操作：素材上传、文案确认、片段预览、单片段重生成、自选片段合成成片；
3. 熟悉整套视频生产逻辑，主动告知当前所处流程阶段，遇到资源访问、生成异常等问题及时友好提示用户；
4. 支持用户修改文案、单独重新生成某一段视频片段、调整字幕与背景音乐配置；
5. 全程围绕带货短视频创作展开对话，简洁高效，不输出无关内容。

## 核心工作流程（严格按顺序执行）

### 第一步：用户输入 → 识别商品
- **执行方式**：自动执行
- **结果处理**：识别结果必须返回显示给用户（商品名称+卖点列表）
- **下一步**：识别成功后，立即自动调用 generateScripts

### 第二步：生成文案+画面Prompt → 等待反馈
- **执行方式**：自动执行
- **结果处理**：文案列表必须返回显示给用户（4组口播文案+画面Prompt）
- **反馈等待**：默认等待用户确认/驳回
  - 如果用户说"驳回/不满意/重新生成" → 重新调用 generateScripts
  - 如果用户说"确认/满意/生成视频" → 调用 generateVideoSegments 进入第三步
  - **特殊情况**：如果用户在初始请求中明确说"不需要反馈/直接生成视频"等，则不等待，直接调用 generateVideoSegments

### 第三步：生成视频片段 → 等待反馈
- **执行方式**：自动执行（用户确认文案后）
- **结果处理**：视频片段预览必须返回显示给用户（每个片段的播放器）
- **反馈等待**：默认等待用户选择
  - 如果用户说"重生成第X段" → 调用 regenerateSegment
  - 如果用户说"合成/完成/确认合成" → 调用 composeFinalVideo 进入第四步
  - **特殊情况**：如果用户在确认文案时已说明"不需要反馈/直接合成"，则不等待，直接调用 composeFinalVideo

### 第四步：合成成片 → 输出
- **执行方式**：自动执行
- **结果处理**：成片下载链接必须返回显示给用户（视频播放器+下载按钮）
- **流程结束**：合成完成后，回复用户"视频已完成"并提供下载链接，不再调用任何工具

## 关键规则（必须严格遵守）
1. **状态检查**：每次调用工具前，先检查当前状态：
   - 如果已有 segments（视频片段），用户说"合成"，必须调用 composeFinalVideo，绝不能再次调用 generateVideoSegments
   - 如果已有 scripts（文案），用户说"生成视频/确认"，必须调用 generateVideoSegments，绝不能再次调用 generateScripts
   - 如果已有 finalVideoUrl，流程结束，不再调用任何工具

2. **工具选择优先级**：
   - 当前阶段 video_generated + 用户说"合成" → composeFinalVideo（最高优先级）
   - 当前阶段 script_generated + 用户说"确认/生成视频" → generateVideoSegments
   - 当前阶段 product_identified → generateScripts（自动执行）

3. **避免重复执行**：
   - 如果 segments 已生成且数量 > 0，绝不要再次调用 generateVideoSegments
   - 如果 scripts 已生成且数量 > 0，绝不要再次调用 generateScripts（除非用户明确要求重生成）
   - 如果 finalVideoUrl 已存在，回复用户"视频已完成"，不再调用任何工具

## 结果显示要求
- 商品识别结果：显示商品名称和卖点标签列表
- 文案生成结果：显示4段文案，每段带序号和画面描述
- 视频片段结果：显示每个片段的预览播放器
- 成片结果：显示最终视频播放器和下载链接

## 工具调用格式
当需要调用工具时，使用以下 JSON 格式（包裹在特殊标签中）：
<tool_call>
{
  "tool": "工具名称",
  "input": {
    "参数名": "参数值"
  }
}
</tool_call>

## 可用工具
1. uploadAndIdentifyProduct - 上传图片并识别商品（支持多图片）
   输入: { imageUrl: string, auxiliaryImages?: string[], productName?: string }
   说明: imageUrl是主图片（重点参考），auxiliaryImages是辅助图片列表（补充参考）
   输出: { productName, features, productImageUrl } - 必须显示
   
2. generateScripts - 生成带货文案
   输入: { productName: string, features: string[] }
   输出: { scripts: [{id, script, prompt}] } - 必须显示
   
3. generateVideoSegments - 生成视频片段
   输入: { scripts: [], productImageUrl: string, productName: string }
   输出: { segments: [{id, videoUrl, audioUrl}] } - 必须显示
   
4. composeFinalVideo - 合成最终视频
   输入: { segments: [], productName: string, bgmUrl?: string, embedSubtitle?: boolean }
   输出: { finalVideoUrl, subtitleUrl } - 必须显示
   
5. regenerateSegment - 重生成单个片段
   输入: { segmentId: number, script: string, prompt: string, productImageUrl: string }
   输出: { videoUrl, audioUrl } - 必须显示
   
6. modifyScript - 修改文案
   输入: { scripts: [], scriptId: number, newScript: string }
   输出: { scripts: [] } - 必须显示

## 重要规则
1. 识别商品成功后，自动继续生成文案（无需等待）
2. 文案生成后，等待用户确认/驳回
3. 用户确认文案后，自动生成视频片段
4. 视频片段生成后，等待用户选择/确认合成
5. 如果用户明确表示"不需要反馈/直接生成/直接合成"等，则跳过等待环节
6. 每个步骤的结果必须返回显示给用户`;

// 解析工具调用
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

// 获取工具执行进度提示消息
function getToolProgressMessage(toolName: string, state?: ChatAgentState): string {
  const scriptsCount = state?.scripts?.length || 4;
  const segmentsCount = state?.scripts?.length || 4;
  
  switch (toolName) {
    case "uploadAndIdentifyProduct":
      return "🔍 正在识别商品信息，预计提取3-5个卖点...";
    case "generateScripts":
      return `✍️ 正在生成带货文案，预计${scriptsCount}段文案，请稍等...`;
    case "generateVideoSegments":
      return `🎬 正在生成视频片段，预计${segmentsCount}个片段，请稍等...`;
    case "composeFinalVideo":
      return "🎞️ 正在合成最终视频，预计需要1-2分钟...";
    case "regenerateSegment":
      return "🔄 正在重新生成片段...";
    case "modifyScript":
      return "📝 正在修改文案...";
    default:
      return "⏳ 正在处理...";
  }
}

// 执行工具（支持实时事件回调）
async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  state: ChatAgentState,
  customHeaders?: Record<string, string>,
  onEvent?: (event: AgentSSEMessage) => void
): Promise<ToolResult> {
  console.log(`[Agent] 执行工具: ${toolName}`, input);
  
  switch (toolName) {
    case "uploadAndIdentifyProduct":
      return await uploadAndIdentifyProduct(
        input.imageUrl as string,
        input.auxiliaryImages as string[] | undefined, // 辅助图片列表
        input.productName as string | undefined,
        customHeaders
      );
    
    case "generateScripts":
      return await generateScripts(
        input.productName as string,
        input.features as string[],
        input.productImageUrl as string | undefined,
        customHeaders,
        state.voiceLanguage // 传递会话的配音语言设置
      );
    
    case "generateVideoSegments":
      // 传递回调函数，实时发送segment_video事件
      return await generateVideoSegments(
        state.scripts || input.scripts,
        input.productImageUrl as string,
        input.productName as string,
        customHeaders,
        (segment) => {
          // 实时回调：yield segment_video事件
          console.log(`[Agent] 实时发送segment_video事件: segmentId=${segment.id}`);
          if (onEvent) {
            onEvent({
              type: "segment_video",
              content: {
                segmentId: segment.id,
                videoUrl: segment.videoUrl,  // 只使用对象存储URL
                audioUrl: segment.audioUrl,
                duration: segment.duration,
                script: segment.script
              }
            });
          }
        }
      );
    
    case "composeFinalVideo":
      // 如果LLM没有传入segments参数，从state中获取
      const segmentsForCompose = (input.segments && Array.isArray(input.segments) && input.segments.length > 0)
        ? input.segments
        : state.segments || [];
      
      if (segmentsForCompose.length === 0) {
        console.error('[Agent] composeFinalVideo: segments为空，无法合成视频');
        return {
          success: false,
          message: "无法合成视频：缺少视频片段数据。请先生成视频片段。",
          error: "segments_empty"
        };
      }
      
      console.log(`[Agent] composeFinalVideo: 使用 ${segmentsForCompose.length} 个片段进行合成`);
      
      return await composeFinalVideo(
        segmentsForCompose as Array<{ id: number; script: string; prompt: string; videoPath?: string; audioPath?: string; videoUrl?: string; audioUrl?: string }>,
        input.productName as string || state.productName || "商品",
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
        message: `未知的工具: ${toolName}`
      };
  }
}

// 需要等待用户反馈的阶段
const WAIT_FOR_USER_FEEDBACK_STAGES = ["script_generated", "video_generated"];

// 自动执行的流程链：识别成功后自动执行下一步
const AUTO_NEXT_TOOL: Record<string, string> = {
  "uploadAndIdentifyProduct": "generateScripts",  // 识别成功 → 自动生成文案
  // generateScripts 后需要等待用户确认
  // generateVideoSegments 后需要等待用户选择
};

// 流式对话节点（支持多轮工具调用）
export async function* chatNodeStream(
  state: ChatAgentState,
  customHeaders?: Record<string, string>
): AsyncGenerator<AgentSSEMessage> {
  console.log("[Agent] 流式对话节点开始执行");
  
  const llmClient = new LLMClient(new Config(), customHeaders);
  
  // 当前状态（会被工具结果更新）
  let currentState = state;
  
  // 构建对话历史
  const conversationHistory: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  
  // 添加历史消息（包含之前的工具调用结果）
  if (state.messages && state.messages.length > 0) {
    conversationHistory.push(...state.messages);
  }
  
  // 检查用户消息是否包含意图标签，直接调用对应工具
  const userMessages = conversationHistory.filter(m => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  
  // 提取消息内容为字符串
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
    // 检查合成视频意图
    if (lastUserMessageContent.includes("[COMPOSE_VIDEO]") && state.segments && state.segments.length > 0) {
      console.log("[Agent] 检测到[COMPOSE_VIDEO]意图，直接调用composeFinalVideo");
      yield { type: "progress", content: "正在合成完整视频..." };
      
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
        
        yield { type: "complete", content: "视频合成完成" };
        return;
      } else {
        yield { type: "error", content: toolResult.message || "合成视频失败" };
        yield { type: "complete", content: "合成失败" };
        return;
      }
    }
    
    // 检查生成分段视频意图
    console.log(`[Agent] 检查[GENERATE_SEGMENTS]意图: hasTag=${lastUserMessageContent.includes("[GENERATE_SEGMENTS]")}, scripts=${state.scripts ? state.scripts.length : 'undefined'}, stage=${state.currentStage}`);
    if (lastUserMessageContent.includes("[GENERATE_SEGMENTS]")) {
      // 确保scripts存在，如果没有则从currentState获取或报错
      const scriptsToUse = state.scripts || currentState.scripts;
      if (!scriptsToUse || scriptsToUse.length === 0) {
        console.error("[Agent] [GENERATE_SEGMENTS]意图检测失败: scripts为空");
        yield { type: "error", content: "文案数据缺失，请先生成文案" };
        yield { type: "complete", content: "生成失败" };
        return;
      }
      
      console.log("[Agent] 检测到[GENERATE_SEGMENTS]意图，直接调用generateVideoSegments，scripts数量:", scriptsToUse.length);
      yield { type: "progress", content: "正在生成分段视频..." };
      
      // 先发送state_update初始化segments数组，确保前端可以接收segment_video事件
      const initialSegments = scriptsToUse.map((script, index) => ({
        id: script.id || index + 1,
        script: script.script || script.feature || '',
        feature: script.feature || '',
        prompt: script.prompt || '',
        videoUrl: '', // 视频生成后通过segment_video事件更新
        audioUrl: '', // 音频生成后通过segment_video事件更新
      }));
      
      yield {
        type: "state_update",
        content: {  // 使用content字段
          ...currentState,
          // 不发送scripts，避免在视频生成阶段显示文案
          // scripts: scriptsToUse,  // 移除这行
          segments: initialSegments,
          currentStage: "video_generating"
        }
      };
      
      console.log(`[Agent] yield state_update事件: segments=${initialSegments.length}个, stage=video_generating, 不包含scripts`);
      
      // 使用stream版本，实时yield事件
      const streamGenerator = generateVideoSegmentsStream(
        scriptsToUse,
        state.productImageUrl || currentState.productImageUrl || "",
        state.productName || currentState.productName || "",
        customHeaders,
        state.videoRatio || currentState.videoRatio // 传递视频比例参数
      );
      
      let toolResult: ToolResult | null = null;
      const segmentsFromStream: Array<{ id: number; videoUrl: string; duration?: number; script?: string }> = [];
      
      // 遍历stream，实时yield segment事件
      for await (const event of streamGenerator) {
        if (event.type === 'segment_video') {
          // tools.ts yield的segment对象使用id字段，不是segmentId
          const segment = event.content as { id: number; segmentId?: number; videoUrl: string; duration?: number; script?: string };
          const actualSegmentId = segment.id || segment.segmentId;
          console.log(`[Agent] yield segment_video事件: id=${actualSegmentId}, videoUrl=${segment.videoUrl?.substring(0, 50)}...`);
          yield {
            type: "segment_video",
            content: {
              segmentId: actualSegmentId,  // 前端期望segmentId字段
              id: actualSegmentId,         // 同时提供id字段以兼容
              videoUrl: segment.videoUrl,
              duration: segment.duration,
              script: segment.script
            }
          };
        } else if (event.type === 'result') {
          toolResult = event.data as ToolResult;
          console.log(`[Agent] 收到最终结果: success=${toolResult.success}`);
        }
      }
      
      if (!toolResult) {
        yield { type: "error", content: "视频生成结果未返回" };
        yield { type: "complete", content: "生成失败" };
        return;
      }
      
      if (toolResult.success) {
        // 直接使用toolResult中的segments（已包含videoUrl）
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
        
        // 转换为符合ChatAgentState.segments类型的格式
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
        
        console.log(`[Agent] 最终segments数量: ${finalSegments.length}`);
        finalSegments.forEach((seg, i) => {
          console.log(`[Agent] segment ${i+1}: id=${seg.id}, videoUrl=${seg.videoUrl?.substring(0, 50)}..., hasVideo=${!!seg.videoUrl}`);
        });
        
        currentState = {
          ...currentState,
          segments: finalSegments,
          currentStage: "video_generated"
        };
        
        // 发送state_update事件，包含完整的segments（已有videoUrl）
        console.log(`[Agent] yield state_update事件: segments=${finalSegments.length}个, stage=video_generated, 包含videoUrl`);
        // 输出完整的videoUrl确认不被截断
        finalSegments.forEach((seg, i) => {
          console.log(`[Agent] state_update segment[${i}]完整videoUrl: ${seg.videoUrl}`);
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
        
        // 发送tool_result事件
        yield {
          type: "tool_result",
          content: {
            tool: "generateVideoSegments",
            success: true,
            message: `分段视频生成完成，共 ${finalSegments.length} 个`,
            data: {
              segments: finalSegments,
              currentStage: "video_generated"
            }
          }
        };
        
        // 发送等待反馈事件
        yield {
          type: "wait_feedback",
          content: {
            message: "分段视频已生成完成，请确认后合成完整视频。",
            state: {
              segments: finalSegments,
              currentStage: "video_generated",
              productName: currentState.productName
            }
          }
        };
        
        yield { type: "complete", content: "分段视频生成完成" };
        return;
      } else {
        yield { type: "error", content: toolResult.message || "生成分段视频失败" };
        yield { type: "complete", content: "生成失败" };
        return;
      }
    }
  }
  
  // 最多执行 5 轮工具调用，防止无限循环
  const MAX_ROUNDS = 5;
  let currentRound = 0;
  
  while (currentRound < MAX_ROUNDS) {
    currentRound++;
    console.log(`[Agent] 第 ${currentRound} 轮执行`);
    
    // 构建状态上下文（添加明确的下一步指令）
    let nextActionHint = "";
    if (currentState.finalVideoUrl) {
      nextActionHint = "【重要】最终视频已生成，流程结束。回复用户'视频已完成，可以下载使用'，不再调用任何工具。";
    } else if (currentState.segments && currentState.segments.length > 0) {
      nextActionHint = "【重要】视频片段已生成，用户说'合成/确认合成'时，必须调用 composeFinalVideo，绝不能再次调用 generateVideoSegments。";
    } else if (currentState.scripts && currentState.scripts.length > 0 && currentState.currentStage === "script_generated") {
      nextActionHint = "【重要】文案已生成，等待用户确认。用户说'确认/生成视频'时，调用 generateVideoSegments。";
    } else if (currentState.productName && currentState.currentStage === "product_identified") {
      nextActionHint = "【重要】商品已识别，自动调用 generateScripts 生成文案。";
    }
    
    const stateContext = `
## 当前状态
- 商品图片: ${currentState.productImageUrl || "未上传"}
- 商品名称: ${currentState.productName || "未知"}
- 商品卖点: ${currentState.features?.join("、") || "未提取"}
- 文案数量: ${currentState.scripts?.length || 0}段
- 视频片段: ${currentState.segments?.length || 0}个
- 最终视频: ${currentState.finalVideoUrl || "未生成"}
- 当前阶段: ${currentState.currentStage}

${nextActionHint}
`;
    
    // 每轮重新构建系统提示词 + 状态上下文
    const systemMessage = {
      role: "system" as const,
      content: SYSTEM_PROMPT + stateContext
    };
    
    // 第二轮及以上不再发送重复的进度消息，工具执行前已有进度提示
    
    // 流式调用 LLM
    console.log(`[Agent] 第 ${currentRound} 轮流式调用 LLM...`);
    const stream = llmClient.stream([systemMessage, ...conversationHistory], {
      model: "doubao-seed-1-8-251228",
      temperature: 0.8
    });
    
    let fullContent = "";
    
    // 收集 LLM 输出但不立即 yield（过滤工具调用格式）
    for await (const chunk of stream) {
      if (chunk.content) {
        const text = chunk.content.toString();
        fullContent += text;
      }
    }
    
    // 检查是否有工具调用
    const toolCall = parseToolCall(fullContent);
    
    // 过滤掉工具调用格式，只提取有意义的文本
    let meaningfulText = fullContent;
    if (toolCall) {
      // 移除工具调用格式部分
      meaningfulText = fullContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    }
    
    // 只 yield 有意义的文本（非空且没有工具调用）
    // 注意：如果有工具调用，不yield文本内容，避免在视频生成时显示文案
    if (meaningfulText && meaningfulText.length > 0 && !toolCall) {
      yield { type: "text", content: meaningfulText };
    }
    
    if (!toolCall) {
      // 没有工具调用，对话结束
      console.log("[Agent] 无工具调用，对话结束");
      yield { type: "complete", content: "对话完成" };
      return;
    }
    
    console.log(`[Agent] 第 ${currentRound} 轮检测到工具调用:`, toolCall.tool);
    
    // 发送进度提示（而不是工具调用格式）
    const toolProgressMessage = getToolProgressMessage(toolCall.tool, state);
    yield { type: "progress", content: toolProgressMessage };
    
    // 创建事件队列，用于收集工具执行过程中的实时事件
    const eventQueue: AgentSSEMessage[] = [];
    
    // 执行工具（传递回调函数，用于实时收集事件）
    const toolResult = await executeTool(
      toolCall.tool,
      toolCall.input,
      currentState,
      customHeaders,
      (event) => {
        // 将实时事件推入队列
        eventQueue.push(event);
      }
    );
    
    // 从队列中yield实时事件（segment_video等）
    for (const event of eventQueue) {
      yield event;
    }
    
    const segmentsLength = (toolResult.data as Record<string, unknown>)?.segments 
      ? ((toolResult.data as Record<string, unknown>).segments as Array<unknown>).length 
      : 0;
    console.log(`[Agent] 工具 ${toolCall.tool} 执行完成: success=${toolResult.success}, segments=${segmentsLength}, 实时事件数=${eventQueue.length}`);
    
    // 更新状态
    if (toolResult.data) {
      currentState = { ...currentState, ...toolResult.data };
      const currentSegmentsLength = currentState.segments?.length || 0;
      console.log(`[Agent] currentState 更新后: segments=${currentSegmentsLength}, stage=${currentState.currentStage}`);
    }
    
    // 发送工具执行结果（简洁消息）
    yield { type: "tool_result", content: toolResult.message, data: toolResult.data };
    
    if (!toolResult.success) {
      yield { type: "error", content: toolResult.message };
      return;
    }
    
    // 将工具结果添加到对话历史
    conversationHistory.push({
      role: "assistant",
      content: fullContent
    });
    conversationHistory.push({
      role: "user",
      content: `工具 ${toolCall.tool} 执行结果：${toolResult.message}\n\n状态更新：${JSON.stringify(toolResult.data || {})}`
    });
    
    // 检查是否需要等待用户反馈
    const newStage = currentState.currentStage;
    if (WAIT_FOR_USER_FEEDBACK_STAGES.includes(newStage)) {
      console.log(`[Agent] 阶段 ${newStage} 需要等待用户反馈`);
      yield { 
        type: "wait_feedback", 
        content: "等待用户反馈",
        data: { stage: newStage, state: currentState }
      };
      return;
    }
    
    // 发送状态更新
    yield {
      type: "state_update",
      content: currentState as unknown as Record<string, unknown>
    };
    
    // 检查是否有自动执行的下一步
    const nextTool = AUTO_NEXT_TOOL[toolCall.tool];
    if (nextTool) {
      console.log(`[Agent] 自动执行下一步: ${nextTool}`);
      // 发送继续信号，让前端知道正在自动执行下一步
      yield {
        type: "progress",
        content: `正在自动执行下一步: ${nextTool}`,
        data: { nextTool }
      };
    }
  }
  
  // 超过最大轮数
  console.log("[Agent] 达到最大执行轮数");
  yield { type: "complete", content: "执行完成" };
}

// 导出
export { SYSTEM_PROMPT, parseToolCall, executeTool };