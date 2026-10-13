/**
 * Agent tools - HTTP request dispatch
 * Only calls the existing APIs over HTTP; no business logic lives here
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { uploadFromRemoteUrl, uploadLocalFile } from '../lib/storage';
import { parseRegenerationResult } from './transport';
import { redactUrl, safeLogError } from '@/lib/log-redact';

const getBaseUrl = () => {
  const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT;
  if (domain) {
    // Use as-is when a protocol is present
    if (domain.startsWith('http://') || domain.startsWith('https://')) {
      return domain;
    }
    // Otherwise prefix https
    return `https://${domain}`;
  }
  return 'http://localhost:5000';
};
const BASE_URL = getBaseUrl();

// Local video storage directory
const getVideoStorageDir = (subDir: string) => {
  const env = process.env.COZE_PROJECT_ENV;
  const baseDir = env === 'PROD' ? '/tmp' : (process.env.COZE_WORKSPACE_PATH || '/workspace/projects');
  const videoDir = path.join(baseDir, 'public', 'videos', subDir);
  
  // Ensure the directory exists
  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }
  return videoDir;
};

// Download a video (preferring object storage)
async function downloadVideoToLocal(
  videoUrl: string, 
  subDir: string, 
  filename: string,
  retries: number = 3
): Promise<{ localPath: string | null; signedUrl: string | null }> {
  let signedUrl: string | null = null;
  let localPath: string | null = null;
  
  // Try object storage first (yields a signed URL)
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Tool] copying video to object storage (attempt ${attempt}/${retries}): ${redactUrl(videoUrl)}`);
      
      const result = await uploadFromRemoteUrl(
        videoUrl,
        `${subDir}/${filename}`,
        'video/mp4',
        60000 // 60s timeout
      );
      
      signedUrl = result.signedUrl;
      console.log(`[Tool] video copied to object storage, signed URL: ${redactUrl(signedUrl)}`);
      break;
    } catch (error) {
      console.error(`[Tool] copy to object storage failed (attempt ${attempt}):`, safeLogError(error));
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  
  // Fallback: download to local storage
  if (!signedUrl) {
    const videoDir = getVideoStorageDir(subDir);
    const filePath = path.join(videoDir, filename);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[Tool] downloading video locally (attempt ${attempt}/${retries}): ${redactUrl(videoUrl)}`);
        
        const response = await axios.get(videoUrl, {
          responseType: 'arraybuffer',
          timeout: 60000 // 60s timeout
        });
        
        fs.writeFileSync(filePath, Buffer.from(response.data));
        localPath = `/videos/${subDir}/${filename}`;
        console.log(`[Tool] video saved locally: [path]`);
        break;
      } catch (error) {
        console.error(`[Tool] local download failed (attempt ${attempt}):`, safeLogError(error));
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
  }
  
  if (!signedUrl && !localPath) {
    console.error(`[Tool] video download failed after retries: ${redactUrl(videoUrl)}`);
  }
  
  return { localPath, signedUrl };
}

// Tool result type
export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

// Session state type
export interface SessionState {
  productImageUrl?: string;
  productName?: string;
  features?: string[];
  scripts?: Array<{ id: number; script: string; prompt?: string }>;
  segments?: Array<{ 
    id: number; 
    script: string; 
    prompt?: string;
    videoPath?: string; 
    audioPath?: string;
    videoUrl?: string;
    audioUrl?: string;
    localVideoPath?: string; // local video path for playback
  }>;
  finalVideoUrl?: string;
  localVideoPath?: string; // local final video path
  finalVideoLocalPath?: string;
  sessionId?: string; // session ID used for the video folder name
  currentStage?: string;
}

/**
 * 1. Upload images and identify the product (main image + supporting images)
 * Calls /api/identify-product
 * @param imageUrl main image URL (primary reference)
 * @param auxiliaryImages supporting image URLs
 * @param _productName optional product name
 * @param customHeaders custom request headers
 */
export async function uploadAndIdentifyProduct(
  imageUrl: string,
  auxiliaryImages?: string[],
  _productName?: string,
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] calling /api/identify-product, main image:', redactUrl(imageUrl));
  if (auxiliaryImages && auxiliaryImages.length > 0) {
    console.log('[Tool] supporting images:', `${auxiliaryImages.length} image(s)`);
  }
  
  try {
    // Remote imageUrl values are downloaded before upload
    const formData = new FormData();
    
    if (imageUrl.startsWith('http')) {
      // Download the image with timeout and retries
      let imageBuffer: Buffer | null = null;
      const maxRetries = 3;
      
      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          const imageResponse = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            headers: customHeaders,
            timeout: 15000 // 15s timeout
          });
          imageBuffer = Buffer.from(imageResponse.data);
          break; // success, stop retrying
        } catch (retryError: unknown) {
          if (axios.isAxiosError(retryError) && (retryError.code === 'ETIMEDOUT' || retryError.code === 'ECONNABORTED')) {
            console.warn(`[Tool] image download timed out, retry ${retry + 1}/${maxRetries}`);
            if (retry < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000)); // wait 2s before retrying
              continue;
            }
          }
          throw retryError; // other errors or the last retry: rethrow
        }
      }
      
      if (!imageBuffer) {
        throw new Error('Image download failed; check that the image URL is reachable');
      }
      
      const imageFile = new File([new Uint8Array(imageBuffer)], 'product.jpg', { type: 'image/jpeg' });
      formData.append('image', imageFile); // main image
      formData.append('isMainImage', 'true'); // mark as main image
      
      // Download and upload supporting images
      if (auxiliaryImages && auxiliaryImages.length > 0) {
        for (let i = 0; i < auxiliaryImages.length; i++) {
          const auxUrl = auxiliaryImages[i];
          if (auxUrl.startsWith('http')) {
            try {
              const auxResponse = await axios.get(auxUrl, {
                responseType: 'arraybuffer',
                headers: customHeaders,
                timeout: 15000
              });
              const auxBuffer = Buffer.from(auxResponse.data);
              const auxFile = new File([new Uint8Array(auxBuffer)], `auxiliary_${i}.jpg`, { type: 'image/jpeg' });
              formData.append('auxiliaryImages', auxFile); // supporting image
              console.log(`[Tool] supporting image ${i + 1} uploaded: ${redactUrl(auxUrl)}`);
            } catch (auxError) {
              console.warn(`[Tool] supporting image ${i + 1} download failed, skipped: ${redactUrl(auxUrl)}`);
            }
          }
        }
      }
    } else {
      // Local path: read the file
      const fs = await import('fs');
      const imageBuffer = fs.readFileSync(imageUrl);
      const imageFile = new File([imageBuffer], 'product.jpg', { type: 'image/jpeg' });
      formData.append('image', imageFile);
    }
    
    const response = await axios.post(
      `${BASE_URL}/api/identify-product`,
      formData,
      { 
        headers: { 
          ...customHeaders,
          'Content-Type': 'multipart/form-data'
        }
      }
    );
    
    const result = response.data;
    return {
      success: true,
      message: `Product identified: ${result.productName}`,
      data: {
        productName: result.productName,
        productImageUrl: result.imageUrl || imageUrl,
        features: result.suggestedFeatures || result.features || [],
        productType: result.productType,
        currentStage: "product_identified"
      }
    };
  } catch (error) {
    console.error('[Tool] identify-product failed:', safeLogError(error));
    return {
      success: false,
      message: 'Product identification failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * 2. Write the promotional script
 * Calls /api/generate-script
 */
export async function generateScripts(
  productName: string,
  features: string[],
  productImageUrl?: string,
  customHeaders?: Record<string, string>,
  voiceLanguage?: string // voiceover language (always english)
): Promise<ToolResult> {
  console.log('[Tool] calling /api/generate-script, voiceover language:', voiceLanguage || 'english');
  
  try {
    const formData = new FormData();
    formData.append('productName', productName);
    formData.append('productSellingPoints', features.join(','));
    formData.append('voiceLanguage', voiceLanguage || 'english'); // voiceover language
    
    // Download and upload the image when present
    if (productImageUrl && productImageUrl.startsWith('http')) {
      const imageResponse = await axios.get(productImageUrl, { 
        responseType: 'arraybuffer',
        headers: customHeaders
      });
      const imageBuffer = Buffer.from(imageResponse.data);
      const imageFile = new File([imageBuffer], 'product.jpg', { type: 'image/jpeg' });
      formData.append('productImage', imageFile);
    }
    
    // generate-script streams SSE; collect the final result
    // Do not set Content-Type manually for FormData; axios adds the boundary
    const response = await axios.post(
      `${BASE_URL}/api/generate-script`,
      formData,
      { 
        headers: customHeaders,
        responseType: 'text'
      }
    );
    
    // Parse the SSE response for scripts and visual prompts
    const lines = response.data.split('\n');
    const scripts: Array<{ id: number; script: string; prompt: string }> = [];
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'script_segment' && data.content) {
            // Add the script first; prompt_segment fills the prompt later
            scripts.push({
              id: data.content.id || data.segmentIndex + 1,
              script: data.content.script || data.content,
              prompt: '' // filled by prompt_segment
            });
          } else if (data.type === 'prompt_segment' && data.content) {
            // Update the matching segment's prompt
            const segmentId = data.content.id;
            const existingScript = scripts.find(s => s.id === segmentId);
            if (existingScript) {
              existingScript.prompt = data.content.prompt;
            } else {
              // Add the full entry when the script is missing
              scripts.push({
                id: segmentId,
                script: data.content.script,
                prompt: data.content.prompt
              });
            }
          } else if (data.type === 'done') {
            // Read the complete data from the done event
            const doneData = JSON.parse(data.content);
            if (doneData.segments && doneData.segments.length > 0) {
              scripts.length = 0; // reset earlier data
              for (const seg of doneData.segments) {
                scripts.push({
                  id: seg.id || scripts.length + 1,
                  script: seg.script || '',
                  prompt: seg.prompt || `${productName} product showcase, professional photography`
                });
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    
    // Fall back to default English scripts and prompts when nothing was parsed
    const lang = voiceLanguage || 'english';
    if (scripts.length === 0) {
      if (lang === 'english') {
        scripts.push(
          { id: 1, script: `${productName} is amazing, highly recommended!`, prompt: `${productName} panoramic display, eye-catching` },
          { id: 2, script: `${features[0] || 'Quality'} is excellent, great value!`, prompt: `${productName} close-up details, quality showcase` },
          { id: 3, script: `Fashionable design, stunning appearance!`, prompt: `${productName} exterior display, design aesthetics` },
          { id: 4, script: `Order now, limited time offer!`, prompt: `${productName} purchase guide, promotional atmosphere` }
        );
      } else {
        scripts.push(
          { id: 1, script: `Meet ${productName}. You are going to love it!`, prompt: `${productName} wide shot, eye-catching` },
          { id: 2, script: `Outstanding ${features[0] || 'quality'} at great value`, prompt: `${productName} detail close-up, quality showcase` },
          { id: 3, script: `Stylish design that turns heads`, prompt: `${productName} exterior showcase, design aesthetics` },
          { id: 4, script: `Order now for a limited-time offer!`, prompt: `${productName} call to action, promotional mood` }
        );
      }
    }
    
    return {
      success: true,
      message: `Script ready: ${scripts.length} scenes with visual prompts`,
      data: { 
        scripts,
        currentStage: "script_generated"
      }
    };
  } catch (error) {
    console.error('[Tool] generate-script failed:', safeLogError(error));
    // Degrade to default English scripts
    const lang = voiceLanguage || 'english';
    const scripts = lang === 'english' ? [
      { id: 1, script: `${productName} is amazing, highly recommended!` },
      { id: 2, script: `Quality is excellent, great value!` },
      { id: 3, script: `Fashionable design, stunning appearance!` },
      { id: 4, script: `Order now, limited time offer!` }
    ] : [
      { id: 1, script: `Meet ${productName}. You are going to love it!` },
      { id: 2, script: `Outstanding quality at great value` },
      { id: 3, script: `Stylish design that turns heads` },
      { id: 4, script: `Order now for a limited-time offer!` }
    ];
    return {
      success: true,
      message: 'Script ready (default)',
      data: { scripts }
    };
  }
}

/**
 * 3. Generate video segments
 * Calls /api/generate-video (SSE stream)
 * Each scene's visual prompt drives its video
 * @returns AsyncGenerator yielding segment events live, then the ToolResult
 */
export async function* generateVideoSegmentsStream(
  scripts: Array<{ id: number; script: string; prompt?: string }>,
  productImageUrl: string,
  productName: string,
  customHeaders?: Record<string, string>,
  ratio?: string // video ratio: '16:9' landscape or '9:16' portrait
): AsyncGenerator<{ type: 'segment_video' | 'result'; content?: unknown; data?: unknown }> {
  const videoRatio = ratio || '16:9'; // default 16:9 landscape
  console.log('[Tool] calling /api/generate-video with a prompt per scene');
  console.log(`[Tool] scripts=${scripts.length}, ratio=${videoRatio}`);
  
  try {
    const formData = new FormData();
    formData.append('productName', productName);
    formData.append('imageUrl', productImageUrl); // parameter name expected by the API
    formData.append('ratio', videoRatio); // video ratio
    
    // Serialise scripts (with prompts) as JSON; the API expects `segments`
    const segmentsForRequest = scripts.map(s => ({
      id: s.id,
      script: s.script,
      prompt: s.prompt || `${productName} product showcase, professional photography`
    }));
    formData.append('segments', JSON.stringify(segmentsForRequest));
    
    // generate-video streams SSE; use fetch for the stream
    console.log(`[Tool] calling generate-video API`);
    
    const fetchResponse = await fetch(`${BASE_URL}/api/generate-video`, {
      method: 'POST',
      headers: customHeaders,
      body: formData
    });
    
    if (!fetchResponse.ok) {
      throw new Error(`generate-video API request failed: ${fetchResponse.status} ${fetchResponse.statusText}`);
    }
    
    // Read the SSE response as a ReadableStream
    const reader = fetchResponse.body?.getReader();
    if (!reader) {
      throw new Error('Could not read the response stream');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    const segments: Array<{
      id: number; 
      script: string; 
      videoPath?: string; 
      audioPath?: string;
      videoUrl?: string;
      audioUrl?: string;
      localVideoPath?: string;
      duration?: number;
    }> = [];
    const sessionId = Date.now().toString();
    
    // Parse SSE events line by line
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep the (possibly partial) last line
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6).trim();
          if (!dataStr) continue;
          
          try {
            const data = JSON.parse(dataStr);
            console.log(`[Tool] event: type=${data.type}`);
            
            if (data.type === 'segment_video' || data.type === 'segment_complete' || data.type === 'segment') {
              const segmentId = data.content?.segmentId || data.content?.id || data.segmentId;
              const videoUrl = data.content?.videoUrl || data.videoUrl;
              const duration = data.content?.duration || data.duration;
              const scriptContent = data.content?.script || '';
              
              console.log(`[Tool] segment: segmentId=${segmentId}, videoUrl=${redactUrl(videoUrl)}`);
              
              if (segmentId && videoUrl) {
                // Download a video (preferring object storage)
                const videoFilename = `segment_${segmentId}_${Date.now()}.mp4`;
                const { signedUrl } = await downloadVideoToLocal(
                  videoUrl, 
                  'segments', 
                  videoFilename,
                  3
                );
                
                console.log(`[Tool] video ${segmentId} downloaded: signedUrl=${redactUrl(signedUrl)}`);
                
                const segment = {
                  id: segmentId,
                  segmentId: segmentId,
                  script: scriptContent || scripts[segmentId - 1]?.script || '',
                  videoUrl: signedUrl || videoUrl,
                  duration: duration || 4
                };
                
                segments.push(segment);
                
                // Yield a segment_video event live
                console.log(`[Tool] yield segment_video: id=${segmentId}`);
                yield { type: 'segment_video', content: segment };
              }
            } else if (data.type === 'error') {
              console.error(`[Tool] generate-video error: ${data.content?.message || data.message}`);
            } else if (data.type === 'complete') {
              console.log(`[Tool] generate-video done event`);
            }
          } catch (parseError) {
            console.error(`[Tool] JSON parse error: ${safeLogError(parseError)}`);
          }
        }
      }
    }
    
    console.log(`[Tool] parsed ${segments.length} segments`);
    
    // Sort segments by ID
    segments.sort((a, b) => a.id - b.id);
    
    // Check for valid video URLs
    const hasValidVideos = segments.some(s => s.videoUrl && s.videoUrl.length > 0);
    
    if (!hasValidVideos) {
      console.error('[Tool] segment generation failed: no valid video URL');
      yield { 
        type: 'result', 
        data: {
          success: false,
          message: 'Video segment generation failed; the video service may be temporarily unavailable, please retry later',
          data: { 
            segments: scripts.map(s => ({
              id: s.id,
              script: s.script,
              videoUrl: undefined,
              duration: 4
            })),
            sessionId,
            currentStage: "script_generated"
          },
          error: 'The video service returned no valid video URL'
        }
      };
      return;
    }
    
    // Debug logging
    segments.forEach((s, i) => {
      console.log(`[Tool] segment ${i + 1}: id=${s.id}, videoUrl=${redactUrl(s.videoUrl)}`);
    });
    
    // Yield the final result
    yield { 
      type: 'result', 
      data: {
        success: true,
        message: `Generated ${segments.length} video segments`,
        data: { 
          segments,
          sessionId,
          currentStage: "video_generated"
        }
      }
    };
    
  } catch (error) {
    console.error('[Tool] generate-video failed:', safeLogError(error));
    yield { 
      type: 'result', 
      data: {
        success: false,
        message: 'Video segment generation failed; you can retry later',
        data: { 
          segments: scripts.map(s => ({
            id: s.id,
            script: s.script,
            videoUrl: undefined,
            duration: 4
          }))
        },
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

/**
 * 3. Generate video segments (legacy callback interface)
 * Calls /api/generate-video (SSE stream)
 * Each scene's visual prompt drives its video
 * @param scripts script list
 * @param productImageUrl product image URL
 * @param productName product name
 * @param customHeaders custom request headers
 * @param onSegmentComplete callback per completed segment (live push)
 */
export async function generateVideoSegments(
  scripts: Array<{ id: number; script: string; prompt?: string }>,
  productImageUrl: string,
  productName: string,
  customHeaders?: Record<string, string>,
  onSegmentComplete?: (segment: { id: number; videoUrl: string; audioUrl?: string; duration?: number; localVideoPath?: string; script: string }) => void
): Promise<ToolResult> {
  console.log('[Tool] calling /api/generate-video with a prompt per scene');
  
  try {
    const formData = new FormData();
    formData.append('productName', productName);
    formData.append('imageUrl', productImageUrl); // parameter name expected by the API
    
    // Serialise scripts (with prompts) as JSON; the API expects `segments`
    const segmentsForRequest = scripts.map(s => ({
      id: s.id,
      script: s.script,
      prompt: s.prompt || `${productName} product showcase, professional photography`
    }));
    formData.append('segments', JSON.stringify(segmentsForRequest));
    
    // generate-video streams SSE; use fetch for the stream
    console.log(`[Tool] calling generate-video API, scripts=${scripts.length}`);
    
    const fetchResponse = await fetch(`${BASE_URL}/api/generate-video`, {
      method: 'POST',
      headers: customHeaders,
      body: formData
    });
    
    if (!fetchResponse.ok) {
      throw new Error(`generate-video API request failed: ${fetchResponse.status} ${fetchResponse.statusText}`);
    }
    
    // Read the SSE response as a ReadableStream
    const reader = fetchResponse.body?.getReader();
    if (!reader) {
      throw new Error('Could not read the response stream');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    const segments: Array<{
      id: number; 
      script: string; 
      videoPath?: string; 
      audioPath?: string;
      videoUrl?: string;
      audioUrl?: string;
      localVideoPath?: string;
      duration?: number;
    }> = [];
    const sessionId = Date.now().toString();
    
    // Parse SSE events line by line
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep the (possibly partial) last line
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6).trim();
          if (!dataStr) continue;
          
          try {
            const data = JSON.parse(dataStr);
            console.log(`[Tool] segment event: type=${data.type}`);
            
            if (data.type === 'segment_video' || data.type === 'segment_complete' || data.type === 'segment') {
              const segmentId = data.content?.segmentId || data.content?.id || data.segmentId;
              const videoUrl = data.content?.videoUrl || data.videoUrl;
              const duration = data.content?.duration || data.duration;
              const scriptContent = data.content?.script || '';
              
              console.log(`[Tool] segment event: segmentId=${segmentId}, videoUrl=${redactUrl(videoUrl)}, duration=${duration}`);
              
              if (segmentId && videoUrl) {
                // Download a video (preferring object storage)
                const videoFilename = `segment_${segmentId}_${Date.now()}.mp4`;
                const { signedUrl } = await downloadVideoToLocal(
                  videoUrl, 
                  'segments', 
                  videoFilename,
                  3
                );
                
                console.log(`[Tool] segment ${segmentId} download result: signedUrl=${redactUrl(signedUrl)}`);
                
                const segment = {
                  id: segmentId,
                  script: scriptContent || scripts[segmentId - 1]?.script || '',
                  videoUrl: signedUrl || videoUrl,
                  localVideoPath: `/videos/segments/${videoFilename}`,
                  duration: duration || 4
                };
                
                segments.push(segment);
                
                // Notify the callback that a segment completed
                if (onSegmentComplete) {
                  console.log(`[Tool] callback: segment ${segmentId} complete`);
                  onSegmentComplete(segment);
                }
              }
            } else if (data.type === 'error') {
              console.error(`[Tool] generate-video error: ${data.content?.message || data.message}`);
            } else if (data.type === 'complete') {
              console.log(`[Tool] generate-video done event`);
            }
          } catch (parseError) {
            console.error(`[Tool] JSON parse error: ${safeLogError(parseError)}`);
          }
        }
      }
    }
    
    console.log(`[Tool] parsed ${segments.length} segments`);
    
    // Sort segments by ID
    segments.sort((a, b) => a.id - b.id);
    
    // Check for valid video URLs
    const hasValidVideos = segments.some(s => s.videoUrl && s.videoUrl.length > 0);
    
    if (!hasValidVideos) {
      console.error('[Tool] segment generation failed: no valid video URL');
      return {
        success: false,
        message: 'Video segment generation failed; the video service may be temporarily unavailable, please retry later',
        data: { 
          segments: scripts.map(s => ({
            id: s.id,
            script: s.script,
            videoUrl: undefined,
            duration: 4
          })),
          sessionId,
          currentStage: "script_generated"
        },
        error: 'The video service returned no valid video URL'
      };
    }
    
    // Debug logging
    segments.forEach((s, i) => {
      console.log(`[Tool] segment ${i + 1}: id=${s.id}, videoUrl=${redactUrl(s.videoUrl)}, localPath=[path]`);
    });
    
    return {
      success: true,
      message: `Generated ${segments.length} video segments (downloaded locally)`,
      data: { 
        segments,
        sessionId,
        currentStage: "video_generated"
      }
    };
  } catch (error) {
    console.error('[Tool] generate-video failed:', safeLogError(error));
    // Return the scripts so the user can retry later
    const segments = scripts.map(s => ({
      id: s.id,
      script: s.script,
      videoPath: undefined,
      audioPath: undefined,
      duration: 4
    }));
    return {
      success: false,
      message: 'Video segment generation failed; you can retry later',
      data: { segments },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * 4. Compose the final video
 * Uses FFmpeg directly (no compose API)
 */
export async function composeFinalVideo(
  segments: Array<{ id: number; script: string; videoUrl?: string; audioUrl?: string; localVideoPath?: string; localAudioPath?: string }>,
  productName: string,
  options?: { bgmUrl?: string; embedSubtitle?: boolean; sessionId?: string },
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] composeFinalVideo: starting composition');
  console.log('[Tool] segments received:', segments?.length || 0);
  
  if (!segments || segments.length === 0) {
    return {
      success: false,
      message: 'No video segments to compose',
      error: 'segments is empty'
    };
  }
  
  const sessionId = options?.sessionId || Date.now().toString();
  const tmpDir = `/tmp/compose_${sessionId}`;
  
  try {
    // Create a temp directory
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    
    console.log(`[Tool] temp directory created: [path]`);
    
    // Sort by ID so composition order is correct
    const sortedSegments = [...segments].sort((a, b) => (a.id || 0) - (b.id || 0));
    console.log(`[Tool] sorted segment IDs: ${sortedSegments.map(s => s.id).join(', ')}`);
    
    // Step 1: download every video and audio file
    const localSegments: Array<{ videoPath: string; audioPath: string; script: string; duration: number }> = [];
    
    for (const segment of sortedSegments) {
      const segId = segment.id;
      console.log(`[Tool] processing segment ${segId}...`);
      
      // Download the video
      const videoPath = path.join(tmpDir, `video_${segId}.mp4`);
      if (segment.videoUrl) {
        console.log(`[Tool] downloading video ${segId}: ${redactUrl(segment.videoUrl)}`);
        const videoResponse = await axios.get(segment.videoUrl, { 
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: customHeaders
        });
        fs.writeFileSync(videoPath, videoResponse.data);
        console.log(`[Tool] video ${segId} downloaded, size: ${fs.statSync(videoPath).size} bytes`);
      } else {
        console.error(`[Tool] segment ${segId} has no videoUrl`);
        continue;
      }
      
      // Download the audio when present
      const audioPath = path.join(tmpDir, `audio_${segId}.mp3`);
      if (segment.audioUrl) {
        console.log(`[Tool] downloading audio ${segId}: ${redactUrl(segment.audioUrl)}`);
        const audioResponse = await axios.get(segment.audioUrl, { 
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: customHeaders
        });
        fs.writeFileSync(audioPath, audioResponse.data);
        console.log(`[Tool] audio ${segId} downloaded, size: ${fs.statSync(audioPath).size} bytes`);
      } else {
        console.log(`[Tool] segment ${segId} has no audioUrl; using the video's own audio`);
        // Without separate audio, use the video's audio track
        fs.copyFileSync(videoPath, audioPath.replace('.mp3', '_from_video.mp4'));
      }
      
      // Read the audio duration
      let duration = 0;
      try {
        const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
        duration = parseFloat(execSync(durationCmd, { encoding: 'utf-8', timeout: 5000 }).trim()) || 0;
      } catch (e) {
        console.log(`[Tool] could not read audio duration, defaulting to 5s`);
        duration = 5;
      }
      
      localSegments.push({
        videoPath,
        audioPath,
        script: segment.script,
        duration
      });
    }
    
    if (localSegments.length === 0) {
      return {
        success: false,
        message: 'No valid video segments to compose',
        error: 'Every segment is missing a video URL'
      };
    }
    
    console.log(`[Tool] ${localSegments.length} valid segments ready for composition`);
    
    // Step 2: merge separate audio into each video
    const mergedVideos: string[] = [];
    
    for (const seg of localSegments) {
      const mergedPath = seg.videoPath.replace('.mp4', '_merged.mp4');
      
      // Check whether the video has an audio track
      const probeCmd = `ffprobe -v quiet -show_streams -select_streams a "${seg.videoPath}"`;
      const probeOutput = execSync(probeCmd, { encoding: 'utf-8', timeout: 5000 });
      const hasAudioInVideo = probeOutput.includes('codec_type=audio');
      
      if (hasAudioInVideo) {
        // The video already has audio
        console.log(`[Tool] video already has an audio track`);
        fs.copyFileSync(seg.videoPath, mergedPath);
      } else if (fs.existsSync(seg.audioPath) && fs.statSync(seg.audioPath).size > 0) {
        // Merge audio and video
        console.log(`[Tool] FFmpeg merging audio and video...`);
        const mergeCmd = `ffmpeg -y -i "${seg.videoPath}" -i "${seg.audioPath}" -c:v copy -c:a aac -shortest "${mergedPath}"`;
        execSync(mergeCmd, { stdio: 'pipe', timeout: 30000 });
      } else {
        // No audio: use the video as-is
        console.log(`[Tool] no audio file, using the original video`);
        fs.copyFileSync(seg.videoPath, mergedPath);
      }
      
      mergedVideos.push(mergedPath);
    }
    
    // Step 3: concatenate the videos (segments already carry subtitles)
    const listPath = path.join(tmpDir, 'filelist.txt');
    const listContent = mergedVideos.map(v => `file '${v}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf-8');
    
    // The concatenated video is the final video (segments already carry subtitles)
    const finalPath = path.join(tmpDir, `final_${Date.now()}.mp4`);
    console.log(`[Tool] FFmpeg concatenating videos (subtitles already embedded)...`);
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${finalPath}"`;
    execSync(concatCmd, { stdio: 'pipe', timeout: 60000 });
    console.log(`[Tool] concatenation complete: [path]`);
    
    // Read the final duration
    const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalPath}"`;
    const finalDuration = parseFloat(execSync(durationCmd, { encoding: 'utf-8', timeout: 5000 }).trim()) || 0;
    console.log(`[Tool] final duration: ${finalDuration}s, size: ${fs.statSync(finalPath).size} bytes`);
    
    // Step 6: upload to object storage
    console.log(`[Tool] uploading the final video to object storage...`);
    const filename = `${productName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_final.mp4`;
    const key = `final/${sessionId}/${filename}`;
    
    // Read and upload the file
    const fileContent = fs.readFileSync(finalPath);
    const uploadResult = await uploadLocalFile(fileContent, filename, 'video/mp4');
    const signedVideoUrl = uploadResult.signedUrl;
    
    console.log(`[Tool] final video uploaded: ${redactUrl(signedVideoUrl)}`);
    
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log(`[Tool] temp directory removed`);
    } catch (e) {
      console.log(`[Tool] temp directory cleanup failed (ignored)`);
    }
    
    return {
      success: true,
      message: `Final video ready! Duration ${finalDuration}s, uploaded to object storage (subtitles embedded)`,
      data: {
        finalVideoUrl: signedVideoUrl,
        finalVideoLocalPath: finalPath,
        // Subtitles are embedded in the segments; no separate subtitle file
        duration: finalDuration,
        currentStage: "done"
      }
    };
  } catch (error) {
    console.error('[Tool] composeFinalVideo failed:', safeLogError(error));
    
    // Clean up temp files
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    
    return {
      success: false,
      message: 'Video composition failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * 5. Edit the script
 * Calls /api/generate-script (regenerates the given scene)
 */
export async function modifyScript(
  scriptId: number,
  newContent: string,
  productName: string,
  features: string[],
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] editing script', scriptId);
  
  // Return the edited script
  return {
    success: true,
    message: `Script ${scriptId} updated`,
    data: {
      modifiedScript: {
        id: scriptId,
        script: newContent
      }
    }
  };
}

/**
 * 6. Regenerate a video segment
 * Calls /api/agent/regenerate
 */
export async function regenerateSegment(
  segmentId: number,
  script: string,
  prompt: string,
  productImageUrl: string,
  productName: string,
  folderPath?: string,
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] calling /api/agent/regenerate');
  console.log('[Tool] visual prompt:', prompt);
  
  try {
    const response = await axios.post(
      `${BASE_URL}/api/agent/regenerate`,
      {
        segmentId,
        script,
        prompt,
        imageUrl: productImageUrl,
        productName,
        folderPath
      },
      { 
        headers: { 
          ...customHeaders,
          'Content-Type': 'application/json'
        },
        timeout: 300000, // 5 minute timeout
        responseType: 'text'
      }
    );
    
    const segment = parseRegenerationResult(response.data, segmentId, script);
    return {
      success: true,
      message: `Segment ${segmentId} regenerated`,
      data: {
        segment
      }
    };
  } catch (error) {
    console.error('[Tool] regenerate failed:', safeLogError(error));
    return {
      success: false,
      message: `Segment ${segmentId} regeneration failed`,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * 7. Upload an image (upload only, no recognition)
 * Calls /api/upload-image
 */
export async function uploadImage(
  imageFile: File,
  customHeaders?: Record<string, string>
): Promise<ToolResult> {
  console.log('[Tool] calling /api/upload-image');
  
  try {
    const formData = new FormData();
    formData.append('image', imageFile);
    
    const response = await axios.post(
      `${BASE_URL}/api/upload-image`,
      formData,
      { 
        headers: { 
          ...customHeaders,
          'Content-Type': 'multipart/form-data'
        }
      }
    );
    
    const result = response.data;
    return {
      success: true,
      message: 'Image uploaded',
      data: {
        imageUrl: result.imageUrl,
        fileName: result.fileName
      }
    };
  } catch (error) {
    console.error('[Tool] upload-image failed:', safeLogError(error));
    return {
      success: false,
      message: 'Image upload failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool name map
 */
export const TOOL_NAMES = {
  UPLOAD_AND_IDENTIFY: 'uploadAndIdentifyProduct',
  GENERATE_SCRIPTS: 'generateScripts',
  GENERATE_VIDEO_SEGMENTS: 'generateVideoSegments',
  COMPOSE_FINAL_VIDEO: 'composeFinalVideo',
  MODIFY_SCRIPT: 'modifyScript',
  REGENERATE_SEGMENT: 'regenerateSegment',
  UPLOAD_IMAGE: 'uploadImage'
};