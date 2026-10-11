import { NextRequest } from 'next/server';
import { LLMClient, S3Storage, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ScriptSegment {
  id: number;
  script: string;
  prompt: string;
  duration: number; // seconds
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
  const voiceLanguage = formData.get('voiceLanguage') as string || 'english'; // voiceover language (English only)

  if (!productName || !productSellingPoints) {
    return new Response(JSON.stringify({ error: 'Missing required parameters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Script language instruction (English only)
  const LANGUAGE_MAP: Record<string, { name: string; instruction: string }> = {
    'english': { name: 'English', instruction: 'Write the voiceover script in English; every line must be English' },
  };
  const languageInfo = LANGUAGE_MAP[voiceLanguage] || LANGUAGE_MAP['english'];
  console.log(`[Generate Script] voiceover language: ${voiceLanguage}, script language: ${languageInfo.name}`);

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
          const identifyPrompt = `Describe the key information in this product image, including:
1. Appearance (colour, shape, materials)
2. Usage scenarios
3. Design highlights

Keep it concise, under 100 words.`;

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
          productInfo = `Product: ${productName}; key selling points: ${productSellingPoints}`;
          sendEvent(controller, { type: 'identify', content: productInfo });
        }

        // Step 2: Generate the segmented voiceover script
        // Prompt template
        let scriptPrompt: string;
        if (voiceLanguage === 'english') {
          // English prompt
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
          // Fallback prompt (also English)
          scriptPrompt = `You are a professional short-form video host and director. Write an engaging, segmented English voiceover script for the product below.

Product name: ${productName}
Key selling points: ${productSellingPoints}
${productInfo ? `Product details: ${productInfo}` : ''}

IMPORTANT: ${languageInfo.instruction}

Requirements:
1. Write 4 voiceover segments, each describing one ad scene
2. Keep each segment to 10-25 words, punchy and concise
3. Suggested structure:
   - Segment 1: an attention-grabbing hook (question, pain point, bold opener)
   - Segment 2: the key selling points and usage scenario
   - Segment 3: real results or comparison advantages
   - Segment 4: a call to action (limited-time offer, order now)
4. Each segment must be visual so it can be filmed
5. The voiceover must be English only
6. Make it persuasive and purchase-driven

Output strictly in this JSON format with no other text:
{
  "segments": [
    {"id": 1, "script": "segment 1 text"},
    {"id": 2, "script": "segment 2 text"},
    {"id": 3, "script": "segment 3 text"},
    {"id": 4, "script": "segment 4 text"}
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
          console.log('[generate-script] raw LLM output:', scriptResult.substring(0, 500));
          const jsonMatch = scriptResult.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            scriptSegments = parsed.segments || [];
            console.log('[generate-script] JSON parsed, segments:', scriptSegments.length);
            console.log('[generate-script] script length per segment:', scriptSegments.map(s => s.script.length));
          }
        } catch (e) {
          // Fallback: split by newlines or numbered list
          console.log('[generate-script] JSON parse failed, using fallback parser');
          const lines = scriptResult.split(/\n+/).filter((line: string) => line.trim());
          scriptSegments = lines.slice(0, 4).map((line: string, index: number) => ({
            id: index + 1,
            script: line.replace(/^\d+[\.、\)]\s*/, '').trim(),
          }));
          console.log('[generate-script] fallback parse, segments:', scriptSegments.length);
        }

        sendEvent(controller, { 
          type: 'script_start', 
          content: `Writing ${scriptSegments.length} voiceover scenes`,
          segmentIndex: scriptSegments.length 
        });

        // Step 3: Generate video prompts for all segments concurrently
        // Send every script_segment event first
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

        // Generate all visual prompts concurrently
        const videoPromptPromises = scriptSegments.map(async (segment, i) => {
          // Video prompts are written in English
          const videoPromptText = `You are a professional short-form video director. Write a shot description for an image-to-video model for the product segment below.

Product name: ${productName}
Voiceover segment: ${segment.script}
${productInfo ? `Product details: ${productInfo}` : ''}

Requirements:
1. Vividly show the scene and selling point this segment expresses
2. Professional, sharp, brightly lit footage
3. Clean, attractive background that keeps the product as the subject
4. Smooth, natural camera movement
5. 4-7 seconds long (matching the voiceover)
6. Be specific: camera angle, movement and what the product shot focuses on
7. IMPORTANT: no text of any kind in the frame - no subtitles, watermarks, logos or product names

Output only the shot description with no other text. Example:
"Open on a front close-up of the product, slowly push in to reveal details, blurred background keeps the product as the subject, soft side light shows the texture"`;

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
              duration: 4 + Math.floor(Math.random() * 4), // 4-7 seconds
            }
          };
        });

        // Wait for every visual prompt
        const promptResults = await Promise.all(videoPromptPromises);
        
        // Sort and send prompt_segment events in order
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
        console.error('Script generation failed:', safeLogError(error));
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : 'Generation failed',
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
