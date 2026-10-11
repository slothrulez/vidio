/**
 * Product identification node
 * Uses the multimodal LLM to identify the product image
 */

import { AgentStateType, Step } from "../state";
import { LLMClient, Config, Message } from "coze-coding-dev-sdk";
import { safeLogError } from '@/lib/log-redact';

export async function identifyProductNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] product identification node started");
  
  if (!state.productImageUrl) {
    return {
      errors: [...state.errors, "Missing product image URL"],
      currentStep: Step.ERROR,
    };
  }
  
  const config = new Config();
  const client = new LLMClient(config);
  
  const messages: Message[] = [
    {
      role: "system",
      content: `You are a product identification expert. Identify the product in the image and answer in English.

Return strictly this JSON with no other text:
{
  "productName": "product name (concise, at most 5 words)",
  "productType": "product category (e.g. baby products, home goods, electronics)",
  "materials": ["material 1", "material 2"],
  "features": ["feature 1", "feature 2", "feature 3"],
  "suggestedPoints": ["selling point 1", "selling point 2", "selling point 3"]
}

Notes:
1. productName must be short enough to use as a folder name
2. materials are suggested materials (e.g. 304 stainless steel, glass, PP plastic)
3. features are product traits (e.g. lightweight, stylish, durable)
4. suggestedPoints are promotional selling points (8-15 words each)`,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Identify this product image and provide product details and suggested selling points, in English." },
        {
          type: "image_url",
          image_url: { url: state.productImageUrl, detail: "high" },
        },
      ],
    },
  ];
  
  try {
    const response = await client.invoke(messages, {
      model: "doubao-seed-1-8-251228",
      temperature: 0.3,
    });
    
    // Parse the JSON result
    let jsonStr = response.content;
    
    // Extract the JSON part if extra text is present
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const result = JSON.parse(jsonStr);
    
    console.log(`[Agent] product identified: ${result.productName}`);
    
    return {
      productName: result.productName || state.productName,
      productType: result.productType || "General product",
      selectedMaterials: result.materials || [],
      selectedFeatures: result.features || [],
      customSellingPoints: result.suggestedPoints || [],
      currentStep: Step.IDENTIFY_PRODUCT,
    };
  } catch (error) {
    console.error("[Agent] product identification failed:", safeLogError(error));
    return {
      errors: [...state.errors, `Product identification failed: ${error}`],
      currentStep: Step.ERROR,
    };
  }
}