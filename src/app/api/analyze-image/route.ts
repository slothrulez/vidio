import { NextRequest, NextResponse } from 'next/server';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import type { Message } from 'coze-coding-dev-sdk';
import { safeLogError } from '@/lib/log-redact';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { imageUrl } = body;

    if (!imageUrl) {
      return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const config = new Config();
    const client = new LLMClient(config, customHeaders);

    // Analyse the image with the LLM
    const systemPrompt = `You are an e-commerce product analyst. Analyse the uploaded product image and identify the product, answering in English.

Return JSON with:
1. productName: a concise product name, at most 5 words
2. productType: the product type (e.g. insulated bottle, stroller, phone case, power bank), at most 3 words
3. materials: 1-3 materials (e.g. 304 stainless steel, glass, PP plastic, silicone, ceramic, aluminium alloy, solid wood)
4. features: 3-5 features of at most 3 words each (e.g. lightweight, waterproof, keeps drinks hot, easy to clean)

Example:
{
  "productName": "Smart insulated bottle",
  "productType": "Insulated bottle",
  "materials": ["304 stainless steel", "PP plastic"],
  "features": ["Keeps drinks hot", "Lightweight", "Leak-proof", "Large capacity"]
}

Return only the JSON.`;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyse this product image and identify its name, type, materials and features. Answer in English.' },
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
    
    // Parse JSON
    let analysisResult;
    try {
      // Extract JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        analysisResult = JSON.parse(content);
      }
    } catch {
      // Defaults when parsing fails
      analysisResult = {
        productName: 'Unidentified product',
        productType: '',
        materials: [],
        features: ['High quality', 'Practical design', 'Great value'],
      };
    }

    return NextResponse.json({
      success: true,
      productName: analysisResult.productName || 'Unidentified product',
      productType: analysisResult.productType || '',
      materials: analysisResult.materials || [],
      features: analysisResult.features || ['High quality', 'Practical design', 'Great value'],
    });
  } catch (error) {
    console.error('Image analysis failed:', safeLogError(error));
    return NextResponse.json(
      { error: 'Image analysis failed, please retry' },
      { status: 500 }
    );
  }
}
