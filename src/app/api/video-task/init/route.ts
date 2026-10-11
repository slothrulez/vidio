import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 创建商品文件夹
 * POST /api/video-task/init
 * Body: { productName: string }
 * 返回: { folderPath: string, folderName: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { productName } = body;

    if (!productName || productName.trim() === '') {
      return new Response(JSON.stringify({ error: '请先填写商品名称' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 清理商品名称，移除特殊字符
    const sanitizedName = productName.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '_');
    
    // 根据环境选择目录
    // 优先使用环境变量判断，如果没有设置则检测 public 目录是否存在
    const publicDir = path.join(process.cwd(), 'public');
    const isProduction = process.env.COZE_PROJECT_ENV === 'PROD' || !fs.existsSync(publicDir);
    const baseDir = isProduction 
      ? '/tmp'  // 生产环境使用 /tmp
      : publicDir;
    
    console.log(`环境判断: COZE_PROJECT_ENV=${process.env.COZE_PROJECT_ENV}, publicDir存在=${fs.existsSync(publicDir)}, 使用目录: [path]`);
    
    // 确保基础目录存在
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    
    // 查找可用的文件夹名称
    let folderName = sanitizedName;
    let folderPath = path.join(baseDir, folderName);
    let suffix = 0;
    
    while (fs.existsSync(folderPath)) {
      suffix++;
      folderName = `${sanitizedName}_${suffix}`;
      folderPath = path.join(baseDir, folderName);
    }
    
    // 创建文件夹
    fs.mkdirSync(folderPath, { recursive: true });
    
    // 创建子文件夹
    const audioDir = path.join(folderPath, 'audio');
    const videoDir = path.join(folderPath, 'video');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.mkdirSync(videoDir, { recursive: true });
    
    console.log(`创建商品文件夹: [path]`);

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
    console.error('创建文件夹失败:', safeLogError(error));
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : '创建文件夹失败' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
