import { NextRequest } from 'next/server';
import axios from 'axios';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { safeLogError } from '@/lib/log-redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StreamData {
  type: 'merge_start' | 'merge_progress' | 'concat_start' | 'complete' | 'error';
  content: string | object;
}

function sendEvent(controller: ReadableStreamDefaultController, data: StreamData) {
  const encoder = new TextEncoder();
  const message = `data: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(encoder.encode(message));
}

/**
 * Compose the final video
 * POST /api/video-task/compose
 * Body: { folderPath: string, segments: [{ audioPath, videoPath, script }] }
 */
export async function POST(request: NextRequest) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const body = await request.json();
        const { folderPath, segments, bgmUrl, embedSubtitle = true } = body as {
          folderPath: string;
          segments: Array<{
            audioPath: string;
            videoPath: string;
            script: string;
          }>;
          bgmUrl?: string;
          embedSubtitle?: boolean;
        };

        if (!folderPath || !segments || segments.length === 0) {
          sendEvent(controller, { type: 'error', content: 'Missing required parameters' });
          controller.close();
          return;
        }

        const outputDir = folderPath;
        const mergedVideos: string[] = [];

        // Step 1: merge audio into each video
        sendEvent(controller, { 
          type: 'merge_start', 
          content: `Merging audio for ${segments.length} video segments...`
        });

        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const mergedVideoPath = path.join(outputDir, `merged_${i + 1}.mp4`);
          
          // Merge audio and video with FFmpeg
          const cmd = `ffmpeg -y -i "${segment.videoPath}" -i "${segment.audioPath}" -c:v copy -c:a aac -shortest "${mergedVideoPath}"`;
          execSync(cmd, { stdio: 'pipe' });
          
          mergedVideos.push(mergedVideoPath);
          
          sendEvent(controller, {
            type: 'merge_progress',
            content: `Merged audio for ${i + 1}/${segments.length} segments`,
          });
        }

        // Step 2: write the subtitle file
        const srtPath = path.join(outputDir, 'subtitles.srt');
        let srtContent = '';
        let currentTime = 0;

        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          // Audio duration
          const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${segment.audioPath}"`;
          const duration = parseFloat(execSync(durationCmd, { encoding: 'utf-8' }).trim());
          
          const startTime = currentTime;
          const endTime = currentTime + duration;
          
          // SRT timestamp format
          const formatTime = (seconds: number) => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            const ms = Math.floor((seconds % 1) * 1000);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
          };
          
          srtContent += `${i + 1}\n`;
          srtContent += `${formatTime(startTime)} --> ${formatTime(endTime)}\n`;
          srtContent += `${segment.script}\n\n`;
          
          currentTime = endTime;
        }

        fs.writeFileSync(srtPath, srtContent, 'utf-8');

        // Step 3: concatenate
        sendEvent(controller, { 
          type: 'concat_start', 
          content: 'Concatenating video segments...'
        });

        // File list
        const listPath = path.join(outputDir, 'filelist.txt');
        const listContent = mergedVideos.map(v => `file '${v}'`).join('\n');
        fs.writeFileSync(listPath, listContent, 'utf-8');

        // Concatenate
        const concatenatedPath = path.join(outputDir, 'concatenated.mp4');
        const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${concatenatedPath}"`;
        execSync(concatCmd, { stdio: 'pipe' });

        // Step 4: subtitles (optional)
        const withSubtitlePath = path.join(outputDir, `with_subtitle_${Date.now()}.mp4`);
        
        if (embedSubtitle) {
          const subtitleCmd = `ffmpeg -y -i "${concatenatedPath}" -vf "subtitles='${srtPath.replace(/'/g, "'\\''")}'" -c:a copy "${withSubtitlePath}"`;
          execSync(subtitleCmd, { stdio: 'pipe' });
        } else {
          // No burned-in subtitles; copy
          fs.copyFileSync(concatenatedPath, withSubtitlePath);
        }

        // Step 5: background music (optional)
        const finalVideoPath = path.join(outputDir, `final_${Date.now()}.mp4`);
        
        if (bgmUrl) {
          // Download the music
          const bgmPath = path.join(outputDir, 'bgm.mp3');
          const bgmResponse = await axios.get(bgmUrl, { responseType: 'arraybuffer' });
          fs.writeFileSync(bgmPath, bgmResponse.data);
          
          // Mix in looped music at 20% volume
          const bgmCmd = `ffmpeg -y -i "${withSubtitlePath}" -i "${bgmPath}" -filter_complex "[1:a]volume=0.2,aloop=0:size=2e+09[bgm];[0:a][bgm]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac "${finalVideoPath}"`;
          execSync(bgmCmd, { stdio: 'pipe' });
          
          // Remove the temporary music file
          fs.unlinkSync(bgmPath);
        } else {
          // No music; use the subtitled video
          fs.copyFileSync(withSubtitlePath, finalVideoPath);
        }

        // Final video duration
        const finalDurationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalVideoPath}"`;
        const finalDuration = parseFloat(execSync(finalDurationCmd, { encoding: 'utf-8' }).trim());

        sendEvent(controller, {
          type: 'complete',
          content: {
            videoUrl: finalVideoPath,
            videoLocalPath: finalVideoPath,
            srtPath: srtPath,
            srtUrl: srtPath,
            duration: finalDuration,
            hasBgm: !!bgmUrl,
            subtitleEmbedded: embedSubtitle,
          },
        });

        controller.close();
      } catch (error) {
        console.error('Composition failed:', safeLogError(error));
        sendEvent(controller, {
          type: 'error',
          content: error instanceof Error ? error.message : 'Composition failed',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
