import { NextRequest, NextResponse } from 'next/server';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import type { Message } from 'coze-coding-dev-sdk';
import { safeLogError } from '@/lib/log-redact';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { imageUrl } = body;

    if (!imageUrl) {
      return NextResponse.json({ error: '缺少图片URL' }, { status: 400 });
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const config = new Config();
    const client = new LLMClient(config, customHeaders);

    // 使用 LLM 分析图片
    const systemPrompt = `你是一个专业的电商商品分析专家。请分析用户上传的商品图片，识别出商品信息。

你需要返回以下信息（JSON格式）：
1. productName: 商品名称，简洁明了，不超过10个字
2. productType: 商品类型，如：保温杯、婴儿车、手机壳、充电宝等，不超过6个字
3. materials: 商品材质数组，包含1-3种材质（如：304不锈钢、玻璃、PP塑料、硅胶、陶瓷、铝合金、实木等）
4. features: 商品特点数组，包含3-5个特点，每个特点不超过6个字（如：便携轻便、防水防尘、保温保冷、易清洗等）

返回格式示例：
{
  "productName": "智能保温杯",
  "productType": "保温杯",
  "materials": ["304不锈钢", "PP塑料"],
  "features": ["保温保冷", "便携轻便", "防漏设计", "大容量"]
}

只返回JSON，不要包含其他内容。`;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请分析这张商品图片，识别商品名称、类型、材质和特点。' },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: 'high',
            },
          },
        ],
      },
    ];

    const response = await client.invoke(messages, {
      model: 'doubao-seed-2-0-lite-260215',
      temperature: 0.3,
    });

    const content = response.content || '';
    
    // 解析 JSON
    let analysisResult;
    try {
      // 尝试提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        analysisResult = JSON.parse(content);
      }
    } catch {
      // 如果解析失败，返回默认值
      analysisResult = {
        productName: '未识别商品',
        productType: '',
        materials: [],
        features: ['高品质', '实用设计', '性价比高'],
      };
    }

    return NextResponse.json({
      success: true,
      productName: analysisResult.productName || '未识别商品',
      productType: analysisResult.productType || '',
      materials: analysisResult.materials || [],
      features: analysisResult.features || ['高品质', '实用设计', '性价比高'],
    });
  } catch (error) {
    console.error('图片分析失败:', safeLogError(error));
    return NextResponse.json(
      { error: '图片分析失败，请重试' },
      { status: 500 }
    );
  }
}
