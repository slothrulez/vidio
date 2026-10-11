import { NextRequest, NextResponse } from 'next/server';
import { LLMClient, S3Storage, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { redactUrl, safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  
  try {
    const formData = await request.formData();
    const imageFile = formData.get('image') as File | null;
    const auxiliaryImageFiles = formData.getAll('auxiliaryImages') as File[];

    if (!imageFile || imageFile.size === 0) {
      return NextResponse.json({ error: 'Upload a main image' }, { status: 400 });
    }

    // Initialize clients with SDK default configuration
    // SDK will automatically handle API credentials from environment or defaults
    const config = new Config();
    const llmClient = new LLMClient(config, customHeaders);
    const storage = new S3Storage();

    // Upload main image to get URL
    const imageBuffer = await imageFile.arrayBuffer();
    const imageKey = await storage.uploadFile({
      fileContent: Buffer.from(imageBuffer),
      fileName: `identify/${Date.now()}_main.jpg`,
      contentType: imageFile.type || 'image/jpeg',
    });
    
    const imageUrl = await storage.generatePresignedUrl({
      key: imageKey,
      expireTime: 300, // 5 minutes for processing
    });

    // Upload auxiliary images and get URLs
    const auxiliaryImageUrls: string[] = [];
    for (let i = 0; i < auxiliaryImageFiles.length; i++) {
      const auxFile = auxiliaryImageFiles[i];
      if (auxFile && auxFile.size > 0) {
        const auxBuffer = await auxFile.arrayBuffer();
        const auxKey = await storage.uploadFile({
          fileContent: Buffer.from(auxBuffer),
          fileName: `identify/${Date.now()}_aux_${i}.jpg`,
          contentType: auxFile.type || 'image/jpeg',
        });
        const auxUrl = await storage.generatePresignedUrl({
          key: auxKey,
          expireTime: 300,
        });
        auxiliaryImageUrls.push(auxUrl);
        console.log(`[API] supporting image ${i + 1} uploaded: ${redactUrl(auxUrl)}`);
      }
    }

    // Build prompt for product identification
    const hasAuxiliaryImages = auxiliaryImageUrls.length > 0;
    const identifyPrompt = hasAuxiliaryImages 
      ? `Carefully analyse these product images and identify the product. The first image is the main image (primary reference); the others are supporting images.

Using every image, identify:
1. Product name: what is it? Give a specific name (e.g. insulated bottle, phone case, headphones)
2. Product type: its category
3. Materials: likely materials judged from the appearance (e.g. stainless steel, plastic, glass, leather)
4. Features: product traits visible across the images (e.g. portable, stylish, waterproof), using details from each angle
5. Suggested selling points: 3-5 selling points based on the product traits

Return JSON in exactly this format:
{
  "productName": "product name",
  "productType": "product type",
  "suggestedMaterials": ["material 1", "material 2"],
  "suggestedFeatures": ["feature 1", "feature 2"],
  "suggestedPoints": ["selling point 1", "selling point 2", "selling point 3"]
}

Return only the JSON with no other text, in English.`
        : `Carefully analyse this product image and identify:

1. Product name: what is it? Give a specific name (e.g. insulated bottle, phone case, headphones)
2. Product type: its category
3. Materials: likely materials judged from the appearance (e.g. stainless steel, plastic, glass, leather)
4. Features: product traits visible in the image (e.g. portable, stylish, waterproof)
5. Suggested selling points: 3-5 selling points based on the product traits

Return JSON in exactly this format:
{
  "productName": "product name",
  "productType": "product type",
  "suggestedMaterials": ["material 1", "material 2"],
  "suggestedFeatures": ["feature 1", "feature 2"],
  "suggestedPoints": ["selling point 1", "selling point 2", "selling point 3"]
}

Return only the JSON with no other text, in English.`;

    // Build message content with all images
    const messageContent: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: identifyPrompt },
      { type: 'image_url', image_url: { url: imageUrl } }, // main image
    ];
    
    // Add auxiliary images to the message
    auxiliaryImageUrls.forEach((url, index) => {
      messageContent.push({
        type: 'image_url',
        image_url: { url },
      });
    });

    const messages = [
      {
        role: 'user' as const,
        content: messageContent,
      },
    ];

    const response = await llmClient.invoke(messages, {
      model: 'doubao-seed-2-0-pro-260215',
      temperature: 0.3,
    });

    // Parse JSON response
    let result;
    try {
      // Extract JSON from response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse the recognition result');
      }
    } catch (e) {
      console.error('Parse failed:', response.content);
      // Fallback result
      result = {
        productName: 'Product',
        productType: 'Unknown product',
        suggestedMaterials: [],
        suggestedFeatures: [],
        suggestedPoints: [],
      };
    }

    return NextResponse.json({
      ...result,
      imageUrl,
      imageKey,
    });
  } catch (error) {
    console.error('Identification failed:', safeLogError(error));
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Identification failed' },
      { status: 500 }
    );
  }
}
