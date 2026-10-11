/**
 * Final composition node
 * Merges every segment's audio and video into the final product video
 */

import { AgentStateType, Step, VideoSegment } from "../state";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { safeLogError } from '@/lib/log-redact';

const execAsync = promisify(exec);

/**
 * Final composition node
 */
export async function composeFinalNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log("[Agent] final composition node started");
  
  const segments = state.segments || [];
  const workDir = state.workDir;
  
  // Compose only the selected segments
  const selectedSegments = segments.filter(seg => seg.isSelected);
  
  if (selectedSegments.length === 0) {
    return {
      errors: [...state.errors, "No video segments selected"],
      currentStep: Step.ERROR,
    };
  }
  
  // Check that segments have audio and video
  console.log(`[Agent] checking ${selectedSegments.length} selected segments`);
  console.log(`[Agent] segment details:`, selectedSegments.map(s => ({
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
  
  // Check for any successful segment
  const validSegments = selectedSegments.filter(
    seg => seg.videoLocalPath && fs.existsSync(seg.videoLocalPath)
  );
  
  if (validSegments.length === 0) {
    return {
      errors: [...state.errors, "Every video segment failed; nothing to compose"],
      currentStep: Step.ERROR,
    };
  }
  
  if (invalidSegments.length > 0) {
    // Derive the audio path from the video path
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
    
    // 1. Merge audio and video per segment
    let currentTime = 0;
    
    for (const seg of selectedSegments) {
      if (!seg.videoLocalPath) continue;
      
      const mergedPath = path.join(workDir, `merged_${seg.id}.mp4`);
      
      // Merge audio and video
      if (seg.audioLocalPath && fs.existsSync(seg.audioLocalPath)) {
        await execAsync(
          `ffmpeg -y -i "${seg.videoLocalPath}" -i "${seg.audioLocalPath}" -c:v copy -c:a aac -shortest "${mergedPath}"`
        );
      } else {
        // No audio; copy the video
        fs.copyFileSync(seg.videoLocalPath, mergedPath);
      }
      
      mergedFiles.push(mergedPath);
      
      // Subtitle info
      const duration = seg.audioDuration || seg.videoDuration || 5;
      subtitles.push({
        text: seg.script,
        startTime: currentTime,
        endTime: currentTime + duration,
      });
      currentTime += duration;
      
      console.log(`[Agent] segment ${seg.id} merged`);
    }
    
    // 2. Concatenate all segments
    const finalVideoPath = path.join(workDir, "final_video.mp4");
    const concatListPath = path.join(workDir, "concat_list.txt");
    
    const concatContent = mergedFiles.map(f => `file '${f}'`).join("\n");
    fs.writeFileSync(concatListPath, concatContent);
    
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalVideoPath}"`
    );
    
    console.log(`[Agent] final video composed: [path]`);
    
    // Remove temporary files
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
    console.error("[Agent] video composition failed:", safeLogError(error));
    return {
      errors: [...state.errors, `Video composition failed: ${error}`],
      currentStep: Step.ERROR,
    };
  }
}