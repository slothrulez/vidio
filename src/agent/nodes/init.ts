/**
 * Init node
 * Creates the working directory
 */

import { AgentStateType } from "../state";
import fs from "fs";
import path from "path";
import {  } from '@/lib/log-redact';

export async function initNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] init node started");
  
  const productName = state.productName || "Untitled product";
  
  // Working directory
  const isProd = !fs.existsSync("/workspace/projects/public") || 
                 process.env.COZE_PROJECT_ENV === "PROD";
  
  const baseDir = isProd ? "/tmp" : "/workspace/projects/public";
  
  // Create the product folder (handle duplicates)
  let folderName = productName;
  let folderPath = path.join(/*turbopackIgnore: true*/ baseDir, folderName);
  let counter = 1;
  
  while (fs.existsSync(/*turbopackIgnore: true*/ folderPath)) {
    folderName = `${productName}_${counter}`;
    folderPath = path.join(/*turbopackIgnore: true*/ baseDir, folderName);
    counter++;
  }
  
  // Subdirectories
  const audioDir = path.join(folderPath, "audio");
  const videoDir = path.join(folderPath, "video");
  
  fs.mkdirSync(folderPath, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  
  console.log(`[Agent] working directory created: [path]`);
  
  // Relative path
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