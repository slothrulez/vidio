/**
 * 合成最终视频节点
 * 合并所有片段的音视频，生成最终带货视频
 */

import { AgentStateType, Step, VideoSegment } from "../state";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { safeLogError } from '@/lib/log-redact';

const execAsync = promisify(exec);

/**
 * 合成最终视频节点
 */
export async function composeFinalNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] 合成最终视频节点开始执行");
  
  const segments = state.segments || [];
  const workDir = state.workDir;
  
  // 只合成被选中的片段
  const selectedSegments = segments.filter(seg => seg.isSelected);
  
  if (selectedSegments.length === 0) {
    return {
      errors: [...state.errors, "没有选中任何视频片段"],
      currentStep: Step.ERROR,
    };
  }
  
  // 检查片段是否都有音频和视频
  console.log(`[Agent] 检查片段状态: ${selectedSegments.length} 个选中片段`);
  console.log(`[Agent] 片段详情:`, selectedSegments.map(s => ({
    id: s.id,
    hasVideo: !!s.videoLocalPath,
    hasAudio: !!s.audioLocalPath,
    videoPath: s.videoLocalPath,
    audioPath: s.audioLocalPath,
    error: s.error,
  })));
  
  const invalidSegments = selectedSegments.filter(
    seg => !seg.audioLocalPath || !seg.videoLocalPath
  );
  
  // 检查是否有任何片段成功生成
  const validSegments = selectedSegments.filter(
    seg => seg.videoLocalPath && fs.existsSync(seg.videoLocalPath)
  );
  
  if (validSegments.length === 0) {
    return {
      errors: [...state.errors, "所有视频片段生成失败，无法合成"],
      currentStep: Step.ERROR,
    };
  }
  
  if (invalidSegments.length > 0) {
    // 尝试从视频路径推导音频路径
    for (const seg of invalidSegments) {
      if (seg.videoLocalPath && !seg.audioLocalPath) {
        const videoName = path.basename(seg.videoLocalPath, ".mp4");
        const audioPath = path.join(workDir, "audio", `${videoName.replace("video_", "audio_")}.mp3`);
        if (fs.existsSync(audioPath)) {
          seg.audioLocalPath = audioPath;
          seg.audioUrl = `/api/file?path=${audioPath}`;
        }
      }
    }
  }
  
  try {
    const mergedFiles: string[] = [];
    const subtitles: { text: string; startTime: number; endTime: number }[] = [];
    
    // 1. 合并每个片段的音视频
    let currentTime = 0;
    
    for (const seg of selectedSegments) {
      if (!seg.videoLocalPath) continue;
      
      const mergedPath = path.join(workDir, `merged_${seg.id}.mp4`);
      
      // 合并音频和视频
      if (seg.audioLocalPath && fs.existsSync(seg.audioLocalPath)) {
        await execAsync(
          `ffmpeg -y -i "${seg.videoLocalPath}" -i "${seg.audioLocalPath}" -c:v copy -c:a aac -shortest "${mergedPath}"`
        );
      } else {
        // 没有音频，直接复制视频
        fs.copyFileSync(seg.videoLocalPath, mergedPath);
      }
      
      mergedFiles.push(mergedPath);
      
      // 添加字幕信息
      const duration = seg.audioDuration || seg.videoDuration || 5;
      subtitles.push({
        text: seg.script,
        startTime: currentTime,
        endTime: currentTime + duration,
      });
      currentTime += duration;
      
      console.log(`[Agent] 片段 ${seg.id} 合并完成`);
    }
    
    // 2. 拼接所有片段
    const finalVideoPath = path.join(workDir, "final_video.mp4");
    const concatListPath = path.join(workDir, "concat_list.txt");
    
    const concatContent = mergedFiles.map(f => `file '${f}'`).join("\n");
    fs.writeFileSync(concatListPath, concatContent);
    
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalVideoPath}"`
    );
    
    console.log(`[Agent] 最终视频合成完成: [path]`);
    
    // 清理临时文件
    fs.unlinkSync(concatListPath);
    mergedFiles.forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    
    return {
      finalVideoUrl: `/api/file?path=${finalVideoPath}`,
      finalVideoLocalPath: finalVideoPath,
      finalSubtitles: subtitles,
      currentStep: Step.COMPOSE_FINAL,
      isComplete: true,
    };
  } catch (error) {
    console.error("[Agent] 视频合成失败:", safeLogError(error));
    return {
      errors: [...state.errors, `视频合成失败: ${error}`],
      currentStep: Step.ERROR,
    };
  }
}