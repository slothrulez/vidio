/**
 * 初始化节点
 * 创建工作目录，准备环境
 */

import { AgentStateType } from "../state";
import fs from "fs";
import path from "path";

export async function initNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] 初始化节点开始执行");
  
  const productName = state.productName || "未命名商品";
  
  // 确定工作目录
  const isProd = !fs.existsSync("/workspace/projects/public") || 
                 process.env.COZE_PROJECT_ENV === "PROD";
  
  const baseDir = isProd ? "/tmp" : "/workspace/projects/public";
  
  // 创建商品文件夹（处理重名）
  let folderName = productName;
  let folderPath = path.join(/*turbopackIgnore: true*/ baseDir, folderName);
  let counter = 1;
  
  while (fs.existsSync(/*turbopackIgnore: true*/ folderPath)) {
    folderName = `${productName}_${counter}`;
    folderPath = path.join(/*turbopackIgnore: true*/ baseDir, folderName);
    counter++;
  }
  
  // 创建子目录
  const audioDir = path.join(folderPath, "audio");
  const videoDir = path.join(folderPath, "video");
  
  fs.mkdirSync(folderPath, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  
  console.log(`[Agent] 工作目录创建完成: ${folderPath}`);
  
  // 计算相对路径
  const relativePath = isProd 
    ? `/api/file?path=${folderPath}` 
    : `/${folderName}`;
  
  return {
    workDir: folderPath,
    relativePath: relativePath,
    taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    currentStep: "init",
    errors: [],
  };
}