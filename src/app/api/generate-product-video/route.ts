import { NextRequest, NextResponse } from 'next/server';
import {
  uploadAndIdentifyProduct,
  generateScripts,
  generateVideoSegments,
  composeFinalVideo,
} from '@/agent/tools';
import { redactUrl, safeLogError } from '@/lib/log-redact';

/**
 * External API: generate a product video in one call
 * 
 * POST /api/generate-product-video
 * 
 * Request Body:
 * {
 *   imageUrl: string;          // product image URL (required)
 *   language?: 'english';      // voiceover language (English only)
 *   productName?: string;      // product name (optional, identified automatically)
 *   callbackUrl?: string;      // callback URL (optional, notified on completion)
 * }
 * 
 * Response:
 * {
 *   success: boolean;
 *   data?: {
 *     sessionId: string;
 *     productName: string;
 *     features: string[];
 *     finalVideoUrl: string;
 *     segments: Array<{ id: number; videoUrl: string; script: string }>;
 *   };
 *   error?: string;
 * }
 */

// Generate a unique session ID
function generateSessionId(): string {
  return `api_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Send the callback
async function sendCallback(callbackUrl: string, data: unknown): Promise<void> {
  if (!callbackUrl) return;
  
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    
    if (!response.ok) {
      console.error(`[API] callback failed: ${response.status}`);
    } else {
      console.log('[API] callback sent');
    }
  } catch (error) {
    console.error('[API] callback send failed:', safeLogError(error));
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const sessionId = generateSessionId();
  
  console.log(`[API] handling external API request: sessionId=${sessionId}`);
  
  try {
    // Parse the body
    const body = await request.json();
    const { imageUrl, language = 'english', productName, callbackUrl } = body;
    
    // Validate required parameters
    if (!imageUrl) {
      return NextResponse.json(
        { success: false, error: 'Missing required parameter: imageUrl' },
        { status: 400 }
      );
    }
    
    // Validate the imageUrl format
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return NextResponse.json(
        { success: false, error: 'imageUrl must be a valid HTTP/HTTPS URL' },
        { status: 400 }
      );
    }
    
    console.log(`[API] params: imageUrl=${redactUrl(imageUrl)}, language=${language}, productName=${productName}`);
    
    // Step 1: identify the product
    console.log('[API] Step 1: identifying the product...');
    const identifyResult = await uploadAndIdentifyProduct(imageUrl, undefined, productName);
    
    if (!identifyResult.success) {
      return NextResponse.json(
        { success: false, error: `Product identification failed: ${identifyResult.error || identifyResult.message}` },
        { status: 500 }
      );
    }
    
    const identifiedProductName = identifyResult.data?.productName as string;
    const features = identifyResult.data?.features as string[] || [];
    const productImageUrl = identifyResult.data?.imageUrl as string;
    
    console.log(`[API] product identified: productName=${identifiedProductName}, features=${features.length}`);
    
    // Step 2: write the script
    console.log('[API] Step 2: writing the script...');
    const scriptsResult = await generateScripts(identifiedProductName, features, productImageUrl, language);
    
    if (!scriptsResult.success) {
      return NextResponse.json(
        { success: false, error: `Script generation failed: ${scriptsResult.error || scriptsResult.message}` },
        { status: 500 }
      );
    }
    
    const scripts = scriptsResult.data?.scripts as Array<{ id: number; script: string; prompt: string }>;
    
    if (!scripts || scripts.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Script generation returned nothing' },
        { status: 500 }
      );
    }
    
    console.log(`[API] script ready: ${scripts.length} scenes`);
    
    // Step 3: generate video segments
    console.log('[API] Step 3: generating video segments...');
    
    // Build the segments input
    const segmentsInput = scripts.map(s => ({
      id: s.id,
      script: s.script,
      prompt: s.prompt,
    }));
    
    const videoResult = await generateVideoSegments(
      segmentsInput,
      productImageUrl,
      identifiedProductName
    );
    
    if (!videoResult.success) {
      return NextResponse.json(
        { success: false, error: `Video segment generation failed: ${videoResult.error || videoResult.message}` },
        { status: 500 }
      );
    }
    
    const segments = videoResult.data?.segments as Array<{
      id: number;
      script: string;
      prompt?: string;
      videoUrl?: string;
      audioUrl?: string;
    }>;
    
    if (!segments || segments.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Video segment generation returned nothing' },
        { status: 500 }
      );
    }
    
    console.log(`[API] segments generated: ${segments.length}`);
    
    // Step 4: compose the final video
    console.log('[API] Step 4: composing the final video...');
    
    // Keep segments with a videoUrl
    const validSegments = segments.filter(s => s.videoUrl);
    
    if (validSegments.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid video segments to compose' },
        { status: 500 }
      );
    }
    
    const composeResult = await composeFinalVideo(validSegments, identifiedProductName, { embedSubtitle: false });
    
    if (!composeResult.success) {
      return NextResponse.json(
        { success: false, error: `Video composition failed: ${composeResult.error || composeResult.message}` },
        { status: 500 }
      );
    }
    
    const finalVideoUrl = composeResult.data?.finalVideoUrl as string;
    
    if (!finalVideoUrl) {
      return NextResponse.json(
        { success: false, error: 'Video composition returned an empty URL' },
        { status: 500 }
      );
    }
    
    console.log(`[API] video composed: finalVideoUrl=${redactUrl(finalVideoUrl)}`);
    
    // Total time
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`[API] flow complete: total ${totalTime}s`);
    
    // Build the response
    const responseData = {
      sessionId,
      productName: identifiedProductName,
      features,
      finalVideoUrl,
      segments: segments.map(s => ({
        id: s.id,
        videoUrl: s.videoUrl,
        script: s.script,
      })),
      scripts: scripts.map(s => ({
        id: s.id,
        script: s.script,
        prompt: s.prompt,
      })),
      totalTimeSeconds: totalTime,
    };
    
    // Send the callback when callbackUrl was provided
    if (callbackUrl) {
      await sendCallback(callbackUrl, {
        success: true,
        data: responseData,
      });
    }
    
    return NextResponse.json({
      success: true,
      data: responseData,
    });
    
  } catch (error: unknown) {
    console.error('[API] request failed:', safeLogError(error));
    
    const errorResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId,
    };
    
    // Send the error callback
    const body = await request.json().catch(() => ({}));
    if (body.callbackUrl) {
      await sendCallback(body.callbackUrl, errorResponse);
    }
    
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

// GET: API usage
export async function GET() {
  return NextResponse.json({
    name: 'vidio - product video generation API',
    version: '1.0.0',
    description: 'Automated API that generates a product video in one call',
    endpoint: '/api/generate-product-video',
    method: 'POST',
    request: {
      imageUrl: {
        type: 'string',
        required: true,
        description: 'Product image URL (HTTP/HTTPS)',
      },
      language: {
        type: 'string',
        required: false,
        default: 'english',
        enum: ['english', 'english'],
        description: 'Voiceover language (english)',
      },
      productName: {
        type: 'string',
        required: false,
        description: 'Product name (identified automatically when omitted)',
      },
      callbackUrl: {
        type: 'string',
        required: false,
        description: 'Callback URL notified with the result',
      },
    },
    response: {
      success: {
        type: 'boolean',
        description: 'Whether the call succeeded',
      },
      data: {
        sessionId: 'string - session ID',
        productName: 'string - product name',
        features: 'string[] - selling points',
        finalVideoUrl: 'string - final video URL',
        segments: 'array - video segments',
        totalTimeSeconds: 'number - total time in seconds',
      },
      error: {
        type: 'string',
        description: 'Error message (only on failure)',
      },
    },
    example: {
      request: {
        imageUrl: 'https://example.com/product.jpg',
        language: 'english',
      },
      response: {
        success: true,
        data: {
          sessionId: 'api_1234567890',
          productName: 'Travel stroller',
          features: ['Adjustable canopy', 'Large storage basket'],
          finalVideoUrl: 'https://xxx.com/final.mp4',
          segments: [
            { id: 1, videoUrl: 'https://xxx.com/segment1.mp4', script: '...' },
          ],
          totalTimeSeconds: 180,
        },
      },
    },
  });
}