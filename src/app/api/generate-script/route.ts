import { NextRequest } from 'next/server';
import { LLMClient, S3Storage, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ScriptSegment {
  id: number;
  script: string;
  prompt: string;
  duration: number; // 秒
}

interface StreamData {
  type: 'identify' | 'script_start' | 'script_segment' | 'prompt_segment' | 'done' | 'error';
  content: string | ScriptSegment;
  segmentIndex?: number;
}

async function sendEvent(controller: ReadableStreamDefaultController, data: StreamData) {
  const encoder = new TextEncoder();
  const message = `data: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(encoder.encode(message));
}

export async function POST(request: NextRequest) {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  
  // Parse form data
  const formData = await request.formData();
  const productName = formData.get('productName') as string;
  const productSellingPoints = formData.get('productSellingPoints') as string;
  const productImageFile = formData.get('productImage') as File | null;
  const voiceLanguage = formData.get('voiceLanguage') as string || 'mandarin'; // 配音语言

  if (!productName || !productSellingPoints) {
    return new Response(JSON.stringify({ error: '缺少必要参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 语言对应的文案语言指示（简化：只有普通话和英语）
  const LANGUAGE_MAP: Record<string, { name: string; instruction: string }> = {
    'mandarin': { name: '普通话', instruction: '请使用中文生成口播文案' },
    'english': { name: '英语', instruction: '请使用英语生成口播文案，所有文案内容必须是英文' },
  };
  const languageInfo = LANGUAGE_MAP[voiceLanguage] || LANGUAGE_MAP['mandarin'];
  console.log(`[Generate Script] 使用配音语言: ${voiceLanguage}, 文案语言: ${languageInfo.name}`);

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Initialize clients with SDK default configuration
        // SDK will automatically handle API credentials from environment or defaults
        const config = new Config();
        const llmClient = new LLMClient(config, customHeaders);
        const storage = new S3Storage();

        let productInfo = '';
        let imageUrl: string | undefined;

        // Step 1: Identify product image if provided
        if (productImageFile && productImageFile.size > 0) {
          // Upload image
          const imageBuffer = await productImageFile.arrayBuffer();
          const imageKey = await storage.uploadFile({
            fileContent: Buffer.from(imageBuffer),
            fileName: `products/${productName}_${Date.now()}.jpg`,
            contentType: productImageFile.type || 'image/jpeg',
          });
          imageUrl = await storage.generatePresignedUrl({
            key: imageKey,
            expireTime: 86400,
          });

          // Use LLM vision to identify product
          const identifyPrompt = `请识别这张商品图片中的关键信息，包括：
1. 商品外观特征（颜色、形状、材质等）
2. 商品使用场景
3. 商品设计亮点

请用简洁的语言描述，不超过100字。`;

          const identifyMessages = [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: identifyPrompt },
                {
                  type: 'image_url' as const,
                  image_url: { url: imageUrl },
                },
              ],
            },
          ];

          const identifyStream = await llmClient.stream(identifyMessages, {
            model: 'doubao-seed-2-0-pro-260215',
            temperature: 0.7,
          });

          for await (const chunk of identifyStream) {
            if (chunk.content) {
              productInfo += chunk.content.toString();
            }
          }

          sendEvent(controller, { type: 'identify', content: productInfo.trim() });
        } else {
          // No image, use basic product info
          productInfo = `商品名称：${productName}，核心卖点：${productSellingPoints}`;
          sendEvent(controller, { type: 'identify', content: productInfo });
        }

        // Step 2: Generate segmented sales script (分段式抖音带货口播文案)
        // 根据语言选择不同的prompt模板
        let scriptPrompt: string;
        if (voiceLanguage === 'english') {
          // 英文prompt
          scriptPrompt = `You are a professional e-commerce livestream host and short video director. Generate an engaging segmented sales script for the following product.

Product Name: ${productName}
Key Selling Points: ${productSellingPoints}
${productInfo ? `Product Features: ${productInfo}` : ''}

【CRITICAL】You must generate ALL content in English. Do NOT use any Chinese characters.

Requirements:
1. Generate 4 script segments, each describing a distinct ad scene
2. Each segment length: 10-25 words, with complete expression and rhythm
3. Segment logic:
   - Segment 1: Attention-grabbing opening hook (question, pain point, or stunning opening)
   - Segment 2: Showcase the key selling point and usage scenario
   - Segment 3: Highlight actual results or competitive advantages
   - Segment 4: Call-to-action closing (limited offer, buy now, etc.)
4. Each segment should have clear visual imagery for video production
5. The script must be persuasive and engaging to drive purchases

Output strictly in the following JSON format without any other text:
{
  "segments": [
    {"id": 1, "script": "Segment 1 content in English"},
    {"id": 2, "script": "Segment 2 content in English"},
    ...
  ]
}`;
        } else {
          // 中文prompt
          scriptPrompt = `你是一位专业的抖音带货主播和短视频导演，请为以下商品生成一段吸引人的分段式口播文案。

商品名称：${productName}
核心卖点：${productSellingPoints}
${productInfo ? `商品特征：${productInfo}` : ''}

【重要】${languageInfo.instruction}

要求：
1. 生成4段口播文案，每段独立描述一个广告切片场景
2. 每段文案长度要求：中文文案每段15-30字，简洁有力
3. 分段逻辑建议：
   - 第1段：吸引注意力的开场钩子（如疑问句、痛点直击、震撼开场）
   - 第2段：展示核心卖点和使用场景
   - 第3段：展示实际效果或对比优势
   - 第4段：引导购买的号召性结尾（限时优惠、立即下单等）
4. 每段要有明确的画面感，方便后续视频制作
5. 口播文案必须使用中文，不能混用其他语言
6. 文案要有带货感染力，能激发观众购买欲望

请严格按照以下JSON格式输出，不要有任何其他说明文字：
{
  "segments": [
    {"id": 1, "script": "第1段文案内容"},
    {"id": 2, "script": "第2段文案内容"},
    ...
  ]
}`;
        }

        const scriptMessages = [{ role: 'user' as const, content: scriptPrompt }];
        const scriptStream = await llmClient.stream(scriptMessages, {
          model: 'doubao-seed-1-8-251228',
          temperature: 0.9,
        });

        let scriptResult = '';
        for await (const chunk of scriptStream) {
          if (chunk.content) {
            scriptResult += chunk.content.toString();
          }
        }

        // Parse script segments
        let scriptSegments: Array<{ id: number; script: string }> = [];
        try {
          // Extract JSON from response
          console.log('[generate-script] LLM原始返回:', scriptResult.substring(0, 500));
          const jsonMatch = scriptResult.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            scriptSegments = parsed.segments || [];
            console.log('[generate-script] JSON解析成功, segments数量:', scriptSegments.length);
            console.log('[generate-script] 每个segment的script长度:', scriptSegments.map(s => s.script.length));
          }
        } catch (e) {
          // Fallback: split by newlines or numbered list
          console.log('[generate-script] JSON解析失败，使用fallback解析');
          const lines = scriptResult.split(/\n+/).filter((line: string) => line.trim());
          scriptSegments = lines.slice(0, 4).map((line: string, index: number) => ({
            id: index + 1,
            script: line.replace(/^\d+[\.、\)]\s*/, '').trim(),
          }));
          console.log('[generate-script] Fallback解析, segments数量:', scriptSegments.length);
        }

        sendEvent(controller, { 
          type: 'script_start', 
          content: `将生成${scriptSegments.length}段口播文案`,
          segmentIndex: scriptSegments.length 
        });

        // Step 3: Generate video prompts for all segments concurrently (并发生成所有画面Prompt)
        // 先发送所有script_segment事件
        for (let i = 0; i < scriptSegments.length; i++) {
          const segment = scriptSegments[i];
          sendEvent(controller, {
            type: 'script_segment',
            content: {
              id: segment.id,
              script: segment.script,
              prompt: '',
              duration: 0,
            },
            segmentIndex: i,
          });
        }

        // 并发生成所有画面prompt
        const videoPromptPromises = scriptSegments.map(async (segment, i) => {
          // 视频prompt始终使用中文，不随语言切换
          const videoPromptText = `你是一位专业的短视频导演，请为以下商品片段生成火山引擎图生视频API的镜头描述。

商品名称：${productName}
口播文案片段：${segment.script}
${productInfo ? `商品特征：${productInfo}` : ''}

要求：
1. 镜头描述要生动展示这段文案表达的场景和卖点
2. 画面专业、清晰、光线明亮
3. 背景简洁美观，突出商品主体
4. 镜头运动流畅自然
5. 时长4-7秒（对应口播时长）
6. 描述要具体，包含镜头角度、运动方式、商品展示重点
7. 【重要】画面中不要出现任何文字字样，包括字幕、水印、品牌logo、产品名称等文字内容，保持画面纯净

请直接输出镜头描述，不要包含任何其他说明文字。示例格式：
"镜头从商品正面特写开始，缓慢推进展示商品细节，背景虚化突出商品主体，柔和侧光照射展现质感"`;

          const videoPromptMessages = [{ role: 'user' as const, content: videoPromptText }];
          const videoPromptStream = await llmClient.stream(videoPromptMessages, {
            model: 'doubao-seed-2-0-pro-260215',
            temperature: 0.8,
          });

          let videoPrompt = '';
          for await (const chunk of videoPromptStream) {
            if (chunk.content) {
              videoPrompt += chunk.content.toString();
            }
          }

          return {
            index: i,
            segmentData: {
              id: segment.id,
              script: segment.script,
              prompt: videoPrompt.trim(),
              duration: 4 + Math.floor(Math.random() * 4), // 4-7秒
            }
          };
        });

        // 等待所有画面prompt生成完成
        const promptResults = await Promise.all(videoPromptPromises);
        
        // 按顺序排序并发送prompt_segment事件
        promptResults.sort((a, b) => a.index - b.index);
        
        const allSegments: ScriptSegment[] = [];
        for (const result of promptResults) {
          allSegments.push(result.segmentData);
          sendEvent(controller, {
            type: 'prompt_segment',
            content: result.segmentData,
            segmentIndex: result.index,
          });
        }

        // Done
        sendEvent(controller, { 
          type: 'done', 
          content: JSON.stringify({ 
            segments: allSegments,
            imageUrl: imageUrl 
          })
        });
        controller.close();
      } catch (error) {
        console.error('文案生成失败:', safeLogError(error));
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : '生成失败',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
