import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create the product folder
 * POST /api/video-task/init
 * Body: { productName: string }
 * Returns: { folderPath: string, folderName: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { productName } = body;

    if (!productName || productName.trim() === '') {
      return new Response(JSON.stringify({ error: 'Enter a product name first' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Strip special characters from the product name
    const sanitizedName = productName.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '_');
    
    // Pick the directory by environment
    // Prefer the environment variable; otherwise check whether public/ exists
    const publicDir = path.join(process.cwd(), 'public');
    const isProduction = process.env.COZE_PROJECT_ENV === 'PROD' || !fs.existsSync(publicDir);
    const baseDir = isProduction 
      ? '/tmp'  // production uses /tmp
      : publicDir;
    
    console.log(`environment: COZE_PROJECT_ENV=${process.env.COZE_PROJECT_ENV}, publicDirExists=${fs.existsSync(publicDir)}, dir: [path]`);
    
    // Ensure the base directory exists
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    
    // Find a free folder name
    let folderName = sanitizedName;
    let folderPath = path.join(baseDir, folderName);
    let suffix = 0;
    
    while (fs.existsSync(folderPath)) {
      suffix++;
      folderName = `${sanitizedName}_${suffix}`;
      folderPath = path.join(baseDir, folderName);
    }
    
    // Create the folder
    fs.mkdirSync(folderPath, { recursive: true });
    
    // Create subfolders
    const audioDir = path.join(folderPath, 'audio');
    const videoDir = path.join(folderPath, 'video');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.mkdirSync(videoDir, { recursive: true });
    
    console.log(`created product folder: [path]`);

    return new Response(JSON.stringify({
      folderPath,
      folderName,
      audioDir,
      videoDir,
      relativePath: `/${folderName}`,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Folder creation failed:', safeLogError(error));
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Folder creation failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
