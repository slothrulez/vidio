/**
 * Script generation node
 * Writes the promotional script and video prompts from the product information
 */

import { AgentStateType, Step } from "../state";
import { LLMClient, Config, Message } from "coze-coding-dev-sdk";
import { safeLogError } from '@/lib/log-redact';

export async function generateScriptsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] script generation node started");
  
  const productName = state.productName || "Product";
  const productType = state.productType || "";
  const materials = state.selectedMaterials || [];
  const features = state.selectedFeatures || [];
  const customPoints = state.customSellingPoints || [];
  
  const config = new Config();
  const client = new LLMClient(config);
  
  // Combine selling point information
  const sellingPoints = [
    ...materials.map(m => `Material: ${m}`),
    ...features.map(f => `Feature: ${f}`),
    ...customPoints,
  ].join("\n");
  
  const messages: Message[] = [
    {
      role: "system",
      content: `You are an expert short-form product video scriptwriter. Write an English promotional short video script from the product information.

Requirements:
1. Write 4-5 script segments of 8-18 words each
2. Each segment needs a catchy opening or ending
3. Fit the fast pace of short-form video
4. Use natural, conversational English
5. Highlight the key selling points

Return strictly this JSON with no other text:
{
  "scripts": ["segment 1", "segment 2", "segment 3", "segment 4"],
  "prompts": [
    {
      "segmentIndex": 0,
      "prompt": "video shot description 1 (detailed camera movement, lighting and scene)"
    },
    {
      "segmentIndex": 1,
      "prompt": "video shot description 2"
    }
  ]
}

Video prompt requirements:
- Describe the camera movement (push, pull, pan, track)
- Describe the lighting (soft, bright, warm or cool tones)
- Describe the background
- Keep the product as the subject
- 40-90 words per prompt`,
    },
    {
      role: "user",
      content: `Product name: ${productName}
Product type: ${productType}

Key selling points:
${sellingPoints}

Write the short video script and the video shot descriptions.`,
    },
  ];
  
  try {
    const response = await client.invoke(messages, {
      model: "doubao-seed-1-8-251228",
      temperature: 0.7,
    });
    
    // Parse the JSON result
    let jsonStr = response.content;
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const result = JSON.parse(jsonStr);
    
    const scripts = result.scripts || [];
    const prompts = result.prompts?.map((p: { prompt: string }) => p.prompt) || [];
    
    console.log(`[Agent] script ready: ${scripts.length} segments`);
    
    // Initialise segment state
    const segments = scripts.map((script: string, index: number) => ({
      id: index + 1,
      script,
      prompt: prompts[index] || "",
      isGenerating: false,
      isSelected: true,
    }));
    
    return {
      scripts,
      prompts,
      segments,
      currentStep: Step.GENERATE_SCRIPTS,
    };
  } catch (error) {
    console.error("[Agent] script generation failed:", safeLogError(error));
    return {
      errors: [...state.errors, `Script generation failed: ${error}`],
      currentStep: Step.ERROR,
    };
  }
}