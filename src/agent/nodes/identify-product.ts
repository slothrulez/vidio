/**
 * 商品识别节点
 * 使用 LLM 多模态能力识别商品图片
 */

import { AgentStateType, Step } from "../state";
import { LLMClient, Config, Message } from "coze-coding-dev-sdk";
import { safeLogError } from '@/lib/log-redact';

export async function identifyProductNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] 商品识别节点开始执行");
  
  if (!state.productImageUrl) {
    return {
      errors: [...state.errors, "缺少商品图片URL"],
      currentStep: Step.ERROR,
    };
  }
  
  const config = new Config();
  const client = new LLMClient(config);
  
  const messages: Message[] = [
    {
      role: "system",
      content: `你是一个专业的商品识别专家。请根据图片识别商品信息。

请严格按照以下JSON格式返回结果，不要添加任何其他文字：
{
  "productName": "商品名称（简洁明确，不超过10个字）",
  "productType": "商品类型分类（如：母婴用品、家居用品、电子产品等）",
  "materials": ["材质1", "材质2"],
  "features": ["特点1", "特点2", "特点3"],
  "suggestedPoints": ["建议卖点1", "建议卖点2", "建议卖点3"]
}

注意：
1. productName 要简洁，适合作为文件夹名称
2. materials 是材质建议（如：304不锈钢、玻璃、PP塑料等）
3. features 是产品特点（如：便携轻便、美观时尚、耐用结实等）
4. suggestedPoints 是适合带货的卖点文案建议（每条15-25字）`,
    },
    {
      role: "user",
      content: [
        { type: "text", text: "请识别这张商品图片，提供商品信息和建议卖点。" },
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
    
    // 解析 JSON 结果
    let jsonStr = response.content;
    
    // 提取 JSON 部分（如果有多余的文字）
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const result = JSON.parse(jsonStr);
    
    console.log(`[Agent] 商品识别完成: ${result.productName}`);
    
    return {
      productName: result.productName || state.productName,
      productType: result.productType || "通用商品",
      selectedMaterials: result.materials || [],
      selectedFeatures: result.features || [],
      customSellingPoints: result.suggestedPoints || [],
      currentStep: Step.IDENTIFY_PRODUCT,
    };
  } catch (error) {
    console.error("[Agent] 商品识别失败:", safeLogError(error));
    return {
      errors: [...state.errors, `商品识别失败: ${error}`],
      currentStep: Step.ERROR,
    };
  }
}