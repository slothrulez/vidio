/**
 * 脚本生成节点
 * 根据商品信息生成带货文案脚本和视频 Prompt
 */

import { AgentStateType, Step } from "../state";
import { LLMClient, Config, Message } from "coze-coding-dev-sdk";
import { safeLogError } from '@/lib/log-redact';

export async function generateScriptsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] 脚本生成节点开始执行");
  
  const productName = state.productName || "商品";
  const productType = state.productType || "";
  const materials = state.selectedMaterials || [];
  const features = state.selectedFeatures || [];
  const customPoints = state.customSellingPoints || [];
  
  const config = new Config();
  const client = new LLMClient(config);
  
  // 组合卖点信息
  const sellingPoints = [
    ...materials.map(m => `材质：${m}`),
    ...features.map(f => `特点：${f}`),
    ...customPoints,
  ].join("\n");
  
  const messages: Message[] = [
    {
      role: "system",
      content: `你是一个专业的带货视频脚本撰写专家。请根据商品信息生成带货短视频脚本。

要求：
1. 生成4-5个脚本片段，每个片段12-21个字
2. 每个片段要有一个吸引人的开头或结尾
3. 适合短视频快节奏的展示风格
4. 语言要口语化、接地气
5. 突出商品的核心卖点

请严格按照以下JSON格式返回，不要添加任何其他文字：
{
  "scripts": ["脚本片段1", "脚本片段2", "脚本片段3", "脚本片段4"],
  "prompts": [
    {
      "segmentId": 1,
      "prompt": "视频画面描述1（详细的镜头运动、光线、场景描述）"
    },
    {
      "segmentId": 2,
      "prompt": "视频画面描述2"
    }
  ]
}

视频Prompt要求：
- 描述具体的镜头运动（推、拉、摇、移等）
- 描述光线效果（柔和、明亮、冷暖色调等）
- 描述场景背景
- 突出商品主体
- 每个Prompt 80-150字`,
    },
    {
      role: "user",
      content: `商品名称：${productName}
商品类型：${productType}

核心卖点：
${sellingPoints}

请生成带货短视频脚本和视频画面描述。`,
    },
  ];
  
  try {
    const response = await client.invoke(messages, {
      model: "doubao-seed-1-8-251228",
      temperature: 0.7,
    });
    
    // 解析 JSON 结果
    let jsonStr = response.content;
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const result = JSON.parse(jsonStr);
    
    const scripts = result.scripts || [];
    const prompts = result.prompts?.map((p: { prompt: string }) => p.prompt) || [];
    
    console.log(`[Agent] 脚本生成完成: ${scripts.length} 个片段`);
    
    // 初始化视频片段状态
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
    console.error("[Agent] 脚本生成失败:", safeLogError(error));
    return {
      errors: [...state.errors, `脚本生成失败: ${error}`],
      currentStep: Step.ERROR,
    };
  }
}