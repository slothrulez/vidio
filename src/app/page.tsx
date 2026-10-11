'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import NextImage from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { getAccessibleUrl } from '@/lib/utils';
import {
  Send,
  Video,
  Download,
  Loader2,
  Image as ImageIcon,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Minimize2,
  Camera,
  Play,
  User,
  AlertCircle,
  CheckCircle2,
  Circle,
  Plus,
  Trash2,
  Pencil,
  MessageSquare,
  Globe,
  RectangleHorizontal,
} from 'lucide-react';

// Keep persisted keys stable so existing avatars and sessions survive rebranding.
// Local storage key for the user avatar
const USER_AVATAR_STORAGE_KEY = 'huxiaoying_user_avatar';

// Local storage key for sessions
const SESSIONS_STORAGE_KEY = 'huxiaoying_sessions';

// Background task state
interface BackgroundTask {
  sessionId: string; // Session the task belongs to
  abortController: AbortController; // Cancels the request
  status: 'running' | 'completed' | 'failed' | 'cancelled'; // Task status
  startedAt: string; // Start time
}

// Session type
interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  state: SessionState;
  progress: {
    currentStage: number;
    stageName: string;
    estimatedTime?: string;
    segmentStatus: Record<number, 'pending' | 'processing' | 'completed' | 'failed'>;
  };
  createdAt: string;
  updatedAt: string;
  isGenerating?: boolean; // Whether a background task is running
  backendSessionId?: string; // Backend session ID used to restore server state
  voiceLanguage?: string; // Voiceover language (per session)
  videoRatio?: '16:9' | '9:16'; // Video ratio (per session, default 16:9)
}

// Floating scroll-to-bottom button
function ScrollToBottomButton({
  onClick,
  isAtBottom,
}: {
  onClick: () => void;
  isAtBottom: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isAtBottom}
      className={`w-9 h-9 rounded-full flex items-center justify-center
        transition-all duration-200 shadow-md
        ${isAtBottom 
          ? 'bg-gray-200/50 text-gray-300 cursor-default opacity-50' 
          : 'bg-white hover:bg-[#7c3aed]/10 text-[#7c3aed] hover:text-[#5b21b6] cursor-pointer'
        }`}
      style={{
        backdropFilter: 'blur(4px)',
      }}
    >
      <ChevronDown className="w-5 h-5" />
    </button>
  );
}

// User avatar component
function UserAvatar({
  avatarUrl,
  onUpload,
  onReset,
  isUploading,
}: {
  avatarUrl: string | null;
  onUpload: (file: File) => Promise<void>;
  onReset: () => void;
  isUploading: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showTooltip, setShowTooltip] = useState(false);

  const handleClick = () => {
    if (isUploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await onUpload(file);
    }
    e.target.value = ''; // Reset so the same file can be chosen again
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (avatarUrl && !isUploading) {
      onReset();
    }
  };

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Avatar container */}
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        disabled={isUploading}
        className={`w-9 h-9 rounded-full overflow-hidden border-2 border-white/50 shadow-sm
          transition-all duration-200 ${isUploading ? 'cursor-default' : 'hover:border-blue-300 hover:shadow-md cursor-pointer'}`}
        title="Right-click to restore the default avatar"
      >
        {isUploading ? (
          <div className="w-full h-full bg-gray-200 flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
          </div>
        ) : avatarUrl ? (
          <img 
            src={avatarUrl} 
            alt="User avatar"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gray-300 flex items-center justify-center">
            <User className="w-4 h-4 text-gray-500" />
          </div>
        )}
      </button>

      {/* Hover hint */}
      {showTooltip && !isUploading && (
        <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 z-50">
          <div className="bg-gray-800 text-white text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap">
            {avatarUrl ? 'Click to change avatar · right-click to reset' : 'Click to upload an avatar'}
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}

// Voiceover language selector
const VOICE_LANGUAGES = [
  { code: 'english', label: 'English', ttsVoice: 'zh_female_vv_uranus_bigtts' },
];

function LanguageSelector({
  language,
  onChange,
}: {
  language: string;
  onChange: (lang: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const currentLang = VOICE_LANGUAGES.find(l => l.code === language) || VOICE_LANGUAGES[0];

  const handleSelect = (langCode: string) => {
    onChange(langCode);
    // The language is bound to the session and persisted with it in localStorage
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-[#666666] hover:text-[#333333] hover:bg-[#F1F3F5] rounded transition-colors"
      >
        <span className="font-medium">Voiceover language:</span>
        <span>{currentLang.label}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-[#E5E5E5] rounded-md shadow-lg z-50 min-w-[120px]">
          {VOICE_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => handleSelect(lang.code)}
              className={`w-full px-3 py-2 text-left text-sm hover:bg-[#F1F3F5] transition-colors ${
                lang.code === language ? 'text-[#B999F3] font-medium bg-[#ECE6F7]' : 'text-[#666666]'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Session sidebar
function SessionSidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onRenameSession,
  onUpdateSessionVoiceLanguage,
  onUpdateSessionVideoRatio,
}: {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onUpdateSessionVoiceLanguage: (sessionId: string, lang: string) => void;
  onUpdateSessionVideoRatio: (sessionId: string, ratio: '16:9' | '9:16') => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [openLangDropdownId, setOpenLangDropdownId] = useState<string | null>(null);
  const [openRatioDropdownId, setOpenRatioDropdownId] = useState<string | null>(null);

  // Group sessions: today and earlier
  const groupSessions = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaySessions = sessions.filter(s => new Date(s.createdAt) >= today);
    const recentSessions = sessions.filter(s => new Date(s.createdAt) < today);
    
    return { todaySessions, recentSessions };
  };

  const { todaySessions, recentSessions } = groupSessions();

  const handleStartEdit = (session: Session) => {
    setEditingId(session.id);
    setEditingTitle(session.title);
  };

  const handleSaveEdit = () => {
    if (editingId && editingTitle.trim()) {
      onRenameSession(editingId, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingTitle('');
  };

  // Close the language dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setOpenLangDropdownId(null);
    };
    if (openLangDropdownId) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [openLangDropdownId]);

  const SessionItem = ({ session }: { session: Session }) => {
    const isSelected = session.id === currentSessionId;
    const isEditing = editingId === session.id;

    return (
      <div
        className={`group relative px-3 py-4 rounded-lg cursor-pointer transition-all duration-200 min-h-[80px]
          ${isSelected 
            ? 'bg-[#D4C2F6] text-white border border-[#B999F3]' 
            : 'bg-[#ECE6F7] text-[#666666] hover:bg-[#F1F3F5]'
          }`}
        onClick={() => !isEditing && onSelectSession(session.id)}
      >
        {isEditing ? (
          <input
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveEdit();
              if (e.key === 'Escape') handleCancelEdit();
            }}
            className="w-full bg-white text-[#333333] px-2 py-1 rounded text-sm outline-none border border-[#D4C2F6]"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="flex flex-col h-full min-h-[80px]">
            {/* Row 1: session title */}
            <div className="flex items-center">
              <div className="text-sm font-medium truncate text-[#333333]">{session.title}</div>
            </div>
            
            {/* Row 2: status and time */}
            <div className="flex justify-start items-center gap-2 mt-1">
              {session.isGenerating && (
                <span className="text-xs text-[#757575] flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Generating
                </span>
              )}
              <span className="text-xs text-[#757575]">
                {new Date(session.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            
            {/* Spacer */}
            <div className="flex-1" />
            
            {/* Row 3: language option */}
            <div className="flex justify-end">
              {/* Language option */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenLangDropdownId(openLangDropdownId === session.id ? null : session.id);
                  }}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-[#FF8A80] text-white hover:bg-[#FF7060] shadow-sm transition-colors"
                  title="Voiceover language"
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>English</span>
                </button>
                
                {/* Dropdown */}
                {openLangDropdownId === session.id && (
                  <div 
                    className="absolute right-0 top-full mt-1 bg-white rounded-md shadow-lg border border-[#E5E5E5] z-50 min-w-[80px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        onUpdateSessionVoiceLanguage(session.id, 'english');
                        setOpenLangDropdownId(null);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-[#F5F0FF] rounded-md ${session.voiceLanguage === 'english' ? 'text-[#7E22CE] font-medium' : 'text-[#666666]'}`}
                    >
                      English
                    </button>
                  </div>
                )}
              </div>
            </div>
            
            {/* Row 4: video ratio option */}
            <div className="flex justify-end mt-1">
              {/* Video ratio option */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenRatioDropdownId(openRatioDropdownId === session.id ? null : session.id);
                  }}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-[#FF8A80] text-white hover:bg-[#FF7060] shadow-sm transition-colors"
                  title="Choose video ratio"
                >
                  <RectangleHorizontal className="w-3.5 h-3.5" />
                  <span>{session.videoRatio === '9:16' ? 'Portrait' : 'Landscape'}</span>
                </button>
                
                {/* Dropdown */}
                {openRatioDropdownId === session.id && (
                  <div 
                    className="absolute right-0 top-full mt-1 bg-white rounded-md shadow-lg border border-[#E5E5E5] z-50 min-w-[80px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        onUpdateSessionVideoRatio(session.id, '16:9');
                        setOpenRatioDropdownId(null);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-[#F5F0FF] rounded-t-md ${session.videoRatio === '16:9' || !session.videoRatio ? 'text-[#7E22CE] font-medium' : 'text-[#666666]'}`}
                    >
                      Landscape 16:9
                    </button>
                    <button
                      onClick={() => {
                        onUpdateSessionVideoRatio(session.id, '9:16');
                        setOpenRatioDropdownId(null);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-[#F5F0FF] rounded-b-md ${session.videoRatio === '9:16' ? 'text-[#7E22CE] font-medium' : 'text-[#666666]'}`}
                    >
                      Portrait 9:16
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Hover actions */}
        {!isEditing && (
          <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleStartEdit(session);
              }}
              className="p-1 hover:bg-[#F1F3F5] rounded text-[#7A7A7A] hover:text-[#333333]"
              title="Rename"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSession(session.id);
              }}
              className="p-1 hover:bg-red-500/20 rounded text-[#7A7A7A] hover:text-red-500"
              title="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-[260px] h-full bg-gradient-to-b from-[#F5E6D3] to-[#FFFFFF] flex flex-col border-r border-[#E5E5E5]">
      {/* vidio logo */}
      <div className="p-4 flex items-center gap-3">
        <NextImage
          src="/assets/agent-avatar.png" 
          alt="vidio"
          width={48}
          height={48}
          className="w-12 h-12 rounded-full object-cover border-2 border-[#D4C2F6] shadow-sm"
        />
        <div className="flex flex-col">
          <span className="text-[#333333] font-semibold text-lg">vidio</span>
          <span className="text-[#666666] text-sm">Product video assistant</span>
        </div>
      </div>

      {/* New chat button */}
      <div className="px-4 pb-4 pt-4 mt-2">
        <button
          onClick={onNewSession}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg
            bg-[#D4C2F6] hover:bg-[#B999F3] text-[#333333] font-medium
            transition-all duration-200 shadow-sm hover:shadow-md"
        >
          <Plus className="w-4 h-4" />
          New chat
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-4">
        {/* Today */}
        {todaySessions.length > 0 && (
          <div>
            <div className="text-xs text-[#999999] font-medium mb-2 px-1">Today</div>
            <div className="space-y-1">
              {todaySessions.map(session => (
                <SessionItem key={session.id} session={session} />
              ))}
            </div>
          </div>
        )}

        {/* Earlier */}
        {recentSessions.length > 0 && (
          <div>
            <div className="text-xs text-[#999999] font-medium mb-2 px-1">Earlier</div>
            <div className="space-y-1">
              {recentSessions.map(session => (
                <SessionItem key={session.id} session={session} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {sessions.length === 0 && (
          <div className="text-center text-[#999999] py-8">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No conversations yet</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Strip system commands such as [xxx] from message text
function filterSystemCommands(content: string): string {
  // Remove [GENERATE_SEGMENTS], [COMPOSE_VIDEO] and similar commands
  return content
    .replace(/\[[A-Z_]+\]\s*/g, '') // Upper-case command tokens
    .replace(/\[[\u4e00-\u9fa5]+\]\s*/g, '') // Legacy non-Latin command tokens
    .trim();
}

// Client-side time component (avoids hydration mismatches)
function ClientTime({ timestamp }: { timestamp: string }) {
  const [time, setTime] = useState<string>('');
  
  useEffect(() => {
    setTime(new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
  }, [timestamp]);
  
  return <span>{time || '--:--'}</span>;
}

// Message type
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  imageUrl?: string;
  auxiliaryImages?: string[]; // Additional image URLs for multi-image uploads
  isStreaming?: boolean;
  state?: Partial<SessionState>;
}

// Scene segment state
interface SegmentProgress {
  id: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  stage?: 'tts' | 'video' | 'merge' | 'upload';
  error?: string;
}

// Global progress state
interface ProgressState {
  currentStage: number; // 1-5, the five main stages
  stageName: string;
  estimatedTime?: string;
  segmentProgress?: SegmentProgress[];
}

// Session state
interface SessionState {
  productImageUrl?: string;
  productName?: string;
  features?: string[];
  scripts?: Array<{ id: number; script: string; prompt: string }>;
  segments?: Array<{
    id: number;
    script: string;
    prompt: string;
    audioUrl?: string;
    videoUrl?: string;
    duration?: number;
    localVideoPath?: string;
    status?: 'pending' | 'processing' | 'completed' | 'failed';
  }>;
  finalVideoUrl?: string;
  localVideoPath?: string;
  finalDuration?: number;
  currentStage?: 'idle' | 'identifying' | 'product_identified' | 'script_generated' | 'video_generating' | 'video_generated' | 'composing' | 'done';
  progress?: ProgressState;
  // Video ratio: '16:9' landscape or '9:16' portrait
  videoRatio?: string;
  // Staged product images (not yet sent)
  pendingImages?: Array<{ id: string; imageUrl: string; thumbnail?: string }>;
}

// Video player (supports 16:9 landscape and 9:16 portrait)
function VideoPlayer({
  videoUrl,
  localVideoPath,
  audioUrl,
  showControls = true,
  ratio = '16:9',
  size = 'segment', // Default segment size
}: {
  videoUrl?: string;
  localVideoPath?: string;
  audioUrl?: string;
  showControls?: boolean;
  ratio?: '16:9' | '9:16';
  size?: 'segment' | 'final'; // Segments are small, the final video is large
}) {
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const effectiveVideoUrl = localVideoPath || (videoUrl ? getAccessibleUrl(videoUrl) : '');
  const effectiveAudioUrl = audioUrl ? getAccessibleUrl(audioUrl) : '';

  // Pick styles from ratio and size
  // Portrait: keep 9:16 and adjust the size
  const aspectClass = ratio === '9:16' 
    ? (size === 'final' 
      ? 'aspect-[9/16] max-h-[50vh] w-auto' // Final video: keep ratio, cap height at 50% of the viewport
      : 'aspect-[9/16] w-[180px]' // Segment: keep ratio, 180px wide (about 320px tall)
    )
    : 'aspect-video max-w-full'; // Landscape: standard ratio

  // Play button click
  const handlePlayClick = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  // Watch fullscreen changes so leaving fullscreen never reloads and loses state
  useEffect(() => {
    const handleFullscreenChange = () => {
      // Do nothing that could drop state when fullscreen exits
      if (!document.fullscreenElement) {
        // Keep playback running without interrupting the user
        console.log('[VideoPlayer] exited fullscreen');
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange); // Safari
    document.addEventListener('mozfullscreenchange', handleFullscreenChange); // Firefox

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Keep video and audio playback in sync
  const handlePlay = useCallback(() => {
    setIsPlaying(true);
    if (audioRef.current && videoRef.current) {
      audioRef.current.currentTime = videoRef.current.currentTime;
      audioRef.current.play();
    }
  }, []);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
    }
  }, []);

  const handleSeeked = useCallback(() => {
    if (audioRef.current && videoRef.current) {
      audioRef.current.currentTime = videoRef.current.currentTime;
    }
  }, []);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current && videoRef.current) {
      // Keep audio and video aligned (0.1s tolerance)
      const diff = Math.abs(audioRef.current.currentTime - videoRef.current.currentTime);
      if (diff > 0.1) {
        audioRef.current.currentTime = videoRef.current.currentTime;
      }
    }
  }, []);

  return (
    <div className={`relative bg-black rounded-lg overflow-hidden ${aspectClass}`}>
      {effectiveVideoUrl ? (
        <>
          <video
            ref={videoRef}
            src={effectiveVideoUrl}
            className="w-full h-full object-contain"
            controls={showControls}
            playsInline
            preload="auto"
            onPlay={handlePlay}
            onPause={handlePause}
            onSeeked={handleSeeked}
            onTimeUpdate={handleTimeUpdate}
            onError={() => {
              setVideoError('Video failed to load');
              setIsLoading(false);
            }}
            onCanPlay={() => {
              setIsLoading(false);
              setVideoError(null);
            }}
          />
          {/* Hidden audio element for the TTS track */}
          {effectiveAudioUrl && (
            <audio
              ref={audioRef}
              src={effectiveAudioUrl}
              preload="auto"
            />
          )}
          
          {/* Floating play button (only when controls are hidden and paused) */}
          {!showControls && !isPlaying && !isLoading && effectiveVideoUrl && (
            <button
              onClick={handlePlayClick}
              className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors cursor-pointer"
            >
              <div className="w-12 h-12 rounded-full bg-white/80 flex items-center justify-center shadow-lg">
                <Play className="w-6 h-6 text-blue-600 ml-1" />
              </div>
            </button>
          )}
        </>
      ) : (
        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
          <p className="text-gray-400 text-sm">Generating video...</p>
        </div>
      )}
      
      {isLoading && effectiveVideoUrl && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center pointer-events-none">
          <Loader2 className="w-6 h-6 animate-spin text-white" />
        </div>
      )}
      
      {videoError && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
          <p className="text-red-400 text-sm">{videoError}</p>
        </div>
      )}
    </div>
  );
}

// Five-stage progress bar
const PROGRESS_STAGES = [
  { key: 1, name: 'Voiceover audio', icon: 'mic' },
  { key: 2, name: 'Video scenes', icon: 'video' },
  { key: 3, name: 'Audio/video merge', icon: 'merge' },
  { key: 4, name: 'Final composition', icon: 'compose' },
  { key: 5, name: 'Done', icon: 'check' },
];

function ProgressTracker({
  currentStage,
  stageName,
  estimatedTime,
  isGenerating,
}: {
  currentStage: number;
  stageName: string;
  estimatedTime?: string;
  isGenerating: boolean;
}) {
  if (!isGenerating || currentStage === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-[#E5E5E5] shadow-sm p-4 mb-4">
      {/* Progress bar */}
      <div className="flex items-center gap-2 mb-3">
        {PROGRESS_STAGES.map((stage, idx) => (
          <div key={stage.key} className="flex items-center flex-1">
            {/* Stage nodes */}
            <div className={`flex items-center justify-center w-8 h-8 rounded-full transition-all duration-300
              ${currentStage >= stage.key 
                ? 'bg-gradient-to-r from-[#B999F3] to-[#D4C2F6] text-white' 
                : 'bg-[#F1F3F5] text-[#999999]'}`}>
              {currentStage === stage.key ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : currentStage > stage.key ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <Circle className="w-4 h-4" />
              )}
            </div>
            {/* Stage name */}
            <div className="ml-2 hidden sm:block">
              <span className={`text-xs font-medium transition-colors
                ${currentStage >= stage.key ? 'text-[#B999F3]' : 'text-[#999999]'}`}>
                {stage.name}
              </span>
            </div>
            {/* Connector */}
            {idx < PROGRESS_STAGES.length - 1 && (
              <div className={`flex-1 h-1 mx-2 rounded transition-all duration-300
                ${currentStage > stage.key ? 'bg-gradient-to-r from-[#B999F3] to-[#D4C2F6]' : 'bg-[#E5E5E5]'}`} />
            )}
          </div>
        ))}
      </div>
      
      {/* Live status text */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-[#B999F3]" />
          <span className="text-sm text-[#B999F3] font-medium">{stageName}</span>
        </div>
        {estimatedTime && (
          <span className="text-xs text-[#666666]">Estimated wait {estimatedTime}</span>
        )}
      </div>
    </div>
  );
}

// Scene card status badge
function SegmentStatusBadge({ status }: { status: 'pending' | 'processing' | 'completed' | 'failed' }) {
  const statusConfig = {
    pending: { color: 'text-[#999999]', bg: 'bg-[#F1F3F5]', icon: Circle, text: 'Pending' },
    processing: { color: 'text-[#B999F3]', bg: 'bg-[#ECE6F7]', icon: Loader2, text: 'Processing' },
    completed: { color: 'text-green-500', bg: 'bg-green-50', icon: CheckCircle2, text: 'Completed' },
    failed: { color: 'text-red-500', bg: 'bg-red-50', icon: AlertCircle, text: 'Failed' },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full ${config.bg} ${config.color}`}>
      <Icon className={`w-3 h-3 ${status === 'processing' ? 'animate-spin' : ''}`} />
      <span className="text-xs font-medium">{config.text}</span>
    </div>
  );
}

// Scene script card (editable, with status and drag support)
function ScriptCard({
  script,
  index,
  total,
  onEdit,
  onRegenerate,
  onMoveUp,
  onMoveDown,
  segmentStatus,
  isGenerating,
}: {
  script: { id: number; script: string; prompt: string };
  index: number;
  total: number;
  onEdit: (field: 'script' | 'prompt', value: string) => void;
  onRegenerate: () => Promise<void>;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  segmentStatus?: 'pending' | 'processing' | 'completed' | 'failed';
  isGenerating?: boolean;
}) {
  const [editingScript, setEditingScript] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [scriptValue, setScriptValue] = useState(script.script);
  const [promptValue, setPromptValue] = useState(script.prompt);

  const handleSaveScript = () => {
    onEdit('script', scriptValue);
    setEditingScript(false);
  };

  const handleSavePrompt = () => {
    onEdit('prompt', promptValue);
    setEditingPrompt(false);
  };

  const handleCancelScript = () => {
    setScriptValue(script.script);
    setEditingScript(false);
  };

  const handleCancelPrompt = () => {
    setPromptValue(script.prompt);
    setEditingPrompt(false);
  };

  const isLast = index === total - 1;
  const status = segmentStatus || 'pending';
  const disabled = isGenerating;

  // Node styles by status
  const nodeStyle = {
    pending: 'bg-[#ECE6F7] text-[#B999F3] border-2 border-[#D4C2F6]',
    processing: 'bg-[#B999F3] text-white border-2 border-[#D4C2F6]',
    completed: 'bg-green-500 text-white border-2 border-green-400',
    failed: 'bg-red-500 text-white border-2 border-red-400',
  };

  return (
    <div className="relative flex items-start gap-4 group">
      {/* Left timeline */}
      <div className="flex flex-col items-center w-8 shrink-0">
        {/* Circle node */}
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0 transition-all duration-300 ${nodeStyle[status]}`}>
          {status === 'processing' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : status === 'completed' ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : status === 'failed' ? (
            <AlertCircle className="w-4 h-4" />
          ) : (
            index + 1
          )}
        </div>
        {/* Connector */}
        {!isLast && (
          <div className={`w-0.5 h-full mt-1 flex-1 min-h-[20px] transition-colors duration-300
            ${status === 'completed' ? 'bg-green-300' : 'bg-[#D4C2F6]'}`} />
        )}
      </div>

      {/* Card body */}
      <div className={`flex-1 bg-white rounded-xl border transition-all duration-200
        ${editingScript || editingPrompt ? 'border-[#D4C2F6] shadow-lg' : 'border-[#E5E5E5] shadow-sm group-hover:shadow-md'}
        ${disabled ? 'opacity-70' : ''}`}>
        
        {/* Status bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#F1F3F5] rounded-t-xl border-b border-[#E5E5E5]">
          <span className="text-xs text-[#999999] font-medium">Scene {index + 1}</span>
          <SegmentStatusBadge status={status} />
        </div>
        
        {/* Top: scene description editor */}
        <div className="p-4 border-b border-[#E5E5E5]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Camera className="w-4 h-4 text-[#7A7A7A]" />
              <span className="text-xs text-[#666666] font-medium">Scene description</span>
            </div>
            {!editingPrompt && !disabled && (
              <button
                onClick={() => setEditingPrompt(true)}
                className="text-xs text-[#7A7A7A] hover:text-[#B999F3] transition-colors"
              >
                Edit
              </button>
            )}
          </div>
          
          {editingPrompt ? (
            <div className="space-y-2">
              <textarea
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                className="w-full p-2 text-sm border border-[#E5E5E5] rounded-md focus:border-[#D4C2F6] focus:ring-1 focus:ring-[#D4C2F6] resize-none"
                rows={4}
                placeholder="Describe the scene..."
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={handleCancelPrompt}
                  className="px-2 py-1 text-xs text-[#666666] hover:bg-[#F1F3F5] rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSavePrompt}
                  className="px-2 py-1 text-xs bg-[#B999F3] text-white hover:bg-[#D4C2F6] rounded"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div
              onClick={() => !disabled && setEditingPrompt(true)}
              className={`text-xs text-[#666666] ${disabled ? 'cursor-default' : 'cursor-pointer hover:text-[#333333]'}`}
            >
              {script.prompt || 'No scene description yet'}
            </div>
          )}
        </div>

        {/* Bottom: voiceover script editor */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-[#666666] font-medium">Voiceover script</span>
            <div className="flex items-center gap-2">
              {!editingScript && (
                <>
                  <button
                    onClick={() => !disabled && setEditingScript(true)}
                    className={`text-xs ${disabled ? 'text-[#999999] cursor-default' : 'text-[#7A7A7A] hover:text-[#B999F3] transition-colors'}`}
                    disabled={disabled}
                  >
                    Edit
                  </button>
                  <button
                    onClick={onRegenerate}
                    className={`text-xs ${disabled ? 'text-[#999999] cursor-default' : 'text-[#B999F3] hover:text-[#D4C2F6] font-medium'}`}
                    disabled={disabled}
                  >
                    Regenerate
                  </button>
                </>
              )}
            </div>
          </div>
          
          {editingScript ? (
            <div className="space-y-2">
              <textarea
                value={scriptValue}
                onChange={(e) => setScriptValue(e.target.value)}
                className="w-full p-2 text-sm font-medium border border-[#E5E5E5] rounded-md focus:border-[#D4C2F6] focus:ring-1 focus:ring-[#D4C2F6] resize-none"
                rows={3}
                placeholder="Write the voiceover script..."
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={handleCancelScript}
                  className="px-2 py-1 text-xs text-[#666666] hover:bg-[#F1F3F5] rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveScript}
                  className="px-2 py-1 text-xs bg-[#B999F3] text-white hover:bg-[#D4C2F6] rounded"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm font-medium text-[#333333] leading-relaxed whitespace-pre-wrap">
              {script.script || 'No voiceover script yet'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Main page
export default function ChatAgentPage() {
  // State
  const [sessions, setSessions] = useState<Session[]>([]); // All sessions
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null); // Current session ID
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [sessionId, setSessionId] = useState<string>(); // Backend session ID
  const [sessionState, setSessionState] = useState<SessionState>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Staged product images (not yet sent)
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; imageUrl: string; thumbnail?: string }>>([]);
  // isGenerating is derived from the current session instead of global state
  // const [isGenerating, setIsGenerating] = useState(false);
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);
  // Voiceover language comes from the current session
  const [generationProgress, setGenerationProgress] = useState<{
    currentStage: number;
    stageName: string;
    estimatedTime?: string;
    segmentStatus: Record<number, 'pending' | 'processing' | 'completed' | 'failed'>;
  }>({
    currentStage: 0,
    stageName: '',
    segmentStatus: {},
  });

  // Background task manager keyed by session
  const backgroundTasksRef = useRef<Map<string, BackgroundTask>>(new Map());

  // Latest currentSessionId for event handlers (independent of React render timing)
  const currentSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // isGenerating is derived per session
  const currentSession = sessions.find(s => s.id === currentSessionId);
  const isGenerating = currentSession?.isGenerating || false;
  const voiceLanguage = currentSession?.voiceLanguage || 'english'; // Voiceover language of the current session

  // Update the voiceover language of a session
  const updateSessionVoiceLanguage = useCallback((sessionId: string, lang: string) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, voiceLanguage: lang } : s
    ));
  }, []);

  // Update the video ratio of a session
  const updateSessionVideoRatio = useCallback((sessionId: string, ratio: '16:9' | '9:16') => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, videoRatio: ratio } : s
    ));
  }, []);

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true); // Whether the list is scrolled to the bottom

  // Load the user avatar from localStorage
  useEffect(() => {
    const savedAvatar = localStorage.getItem(USER_AVATAR_STORAGE_KEY);
    if (savedAvatar) {
      setUserAvatar(savedAvatar);
    }
    // Voiceover language is stored per session, not as a global setting
    // Load sessions from localStorage
    const savedSessions = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (savedSessions) {
      try {
        const parsed = JSON.parse(savedSessions) as Session[];
        // Background tasks do not survive a reload, so reset isGenerating everywhere
        const sessionsWithResetGenerating = parsed.map(s => ({
          ...s,
          isGenerating: false, // Reset generation state
        }));
        setSessions(sessionsWithResetGenerating);
        // Select the first session and load its data
        if (sessionsWithResetGenerating.length > 0) {
          const firstSession = sessionsWithResetGenerating[0];
          setCurrentSessionId(firstSession.id);
          setMessages(firstSession.messages);
          setSessionState(firstSession.state);
          setGenerationProgress(firstSession.progress);
          setSessionId(firstSession.backendSessionId);
          // isGenerating is derived from currentSession
        }
      } catch (e) {
        console.error('Failed to parse saved sessions:', e);
        // Create a default session
        createDefaultSession();
      }
    } else {
      // No saved sessions: create a default one
      createDefaultSession();
    }
  }, []);

  // Create the default welcome session
  const createDefaultSession = useCallback(() => {
    const defaultSession: Session = {
      id: `session_${Date.now()}`,
      title: 'New chat',
      messages: [{
        id: 'welcome',
        role: 'assistant',
        content: 'Hi! I am vidio, your product video assistant.\n\nI can help you:\n1. Upload product images and identify the product and selling points\n2. Write a scene-by-scene voiceover script with visual prompts\n3. Generate product video clips\n4. Compose the final video\n\nUpload a product image or describe your product to get started!',
        timestamp: new Date().toISOString(),
      }],
      state: {},
      progress: {
        currentStage: 0,
        stageName: '',
        segmentStatus: {},
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setSessions([defaultSession]);
    setCurrentSessionId(defaultSession.id);
    setMessages(defaultSession.messages);
    setSessionState({});
    setGenerationProgress({
      currentStage: 0,
      stageName: '',
      segmentStatus: {},
    });
  }, []);

  // Create a default session when none exist
  useEffect(() => {
    if (sessions.length === 0 && !currentSessionId) {
      createDefaultSession();
    }
  }, [sessions.length, currentSessionId, createDefaultSession]);

  // Persist sessions to localStorage
  useEffect(() => {
    if (sessions.length > 0) {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    }
  }, [sessions]);

  // Clean up background tasks on unmount
  useEffect(() => {
    return () => {
      // Cancel every running background task
      backgroundTasksRef.current.forEach((task, sessionId) => {
        if (task.status === 'running') {
          task.abortController.abort();
          task.status = 'cancelled';
          console.log(`Cancelled background task for session ${sessionId}`);
        }
      });
      backgroundTasksRef.current.clear();
    };
  }, []);

  // Save session data on visibility changes (prevents loss after leaving fullscreen)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && sessions.length > 0) {
        // Save when the page is hidden (fullscreen, tab switch)
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
        console.log('[visibility] session data saved');
      }
    };

    const handlePageHide = () => {
      // Save before unload
      if (sessions.length > 0) {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
        console.log('[unload] session data saved');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [sessions]);

  // Create a new session (saving the current one first)
  const handleNewSession = useCallback(() => {
    // Save the current session state
    if (currentSessionId) {
      setSessions(prev => prev.map(s => 
        s.id === currentSessionId 
          ? { 
              ...s, 
              messages, 
              state: sessionState, 
              progress: generationProgress, 
              isGenerating, 
              backendSessionId: sessionId,
              updatedAt: new Date().toISOString() 
            }
          : s
      ));
    }
    
    // Unique ID: timestamp + random suffix
    const newId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const newSession: Session = {
      id: newId,
      title: 'New chat',
      messages: [{
        id: 'welcome',
        role: 'assistant',
        content: 'Hi! I am vidio, your product video assistant.\n\nI can help you:\n1. Upload product images and identify the product and selling points\n2. Write a scene-by-scene voiceover script with visual prompts\n3. Generate product video clips\n4. Compose the final video\n\nUpload a product image or describe your product to get started!',
        timestamp: new Date().toISOString(),
      }],
      state: {},
      progress: {
        currentStage: 0,
        stageName: '',
        segmentStatus: {},
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      voiceLanguage: 'english', // Default voiceover language
      videoRatio: '16:9', // Default video ratio (landscape)
    };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newId);
    setMessages(newSession.messages);
    setSessionState({});
    setGenerationProgress({
      currentStage: 0,
      stageName: '',
      segmentStatus: {},
    });
    setSessionId(undefined);
    // isGenerating is derived from currentSession
    setIsLoading(false);
  }, [currentSessionId, messages, sessionState, generationProgress, isGenerating, sessionId]);

  // Switch session (save the current one, keep background tasks running)
  const handleSelectSession = useCallback((id: string) => {
    // Save the current session state
    if (currentSessionId) {
      setSessions(prev => prev.map(s => 
        s.id === currentSessionId 
          ? { 
              ...s, 
              messages, 
              state: sessionState, 
              progress: generationProgress, 
              isGenerating, 
              backendSessionId: sessionId,
              updatedAt: new Date().toISOString() 
            }
          : s
      ));
    }
    
    // Load the new session state
    const session = sessions.find(s => s.id === id);
    if (session) {
      setCurrentSessionId(id);
      setMessages(session.messages);
      setSessionState(session.state);
      setGenerationProgress(session.progress);
      setSessionId(session.backendSessionId);
      // isGenerating is derived from currentSession
    }
  }, [currentSessionId, sessions, messages, sessionState, generationProgress, isGenerating, sessionId]);

  // Delete a session (cancelling its background task)
  const handleDeleteSession = useCallback((id: string) => {
    // Cancel the session's background task
    const task = backgroundTasksRef.current.get(id);
    if (task && task.status === 'running') {
      task.abortController.abort();
      task.status = 'cancelled';
      backgroundTasksRef.current.delete(id);
    }
    
    setSessions(prev => {
      const newSessions = prev.filter(s => s.id !== id);
      // If the current session was deleted, switch to the first one or create a new one
      if (id === currentSessionId) {
        if (newSessions.length > 0) {
          const firstSession = newSessions[0];
          setCurrentSessionId(firstSession.id);
          setMessages(firstSession.messages);
          setSessionState(firstSession.state);
          setGenerationProgress(firstSession.progress);
          setSessionId(firstSession.backendSessionId);
          // isGenerating is derived from currentSession
        } else {
          // No sessions left: create one
          handleNewSession();
        }
      }
      // Update localStorage
      if (newSessions.length > 0) {
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(newSessions));
      } else {
        localStorage.removeItem(SESSIONS_STORAGE_KEY);
      }
      return newSessions;
    });
  }, [currentSessionId, handleNewSession]);

  // Rename a session
  const handleRenameSession = useCallback((id: string, newTitle: string) => {
    setSessions(prev => prev.map(s => 
      s.id === id ? { ...s, title: newTitle, updatedAt: new Date().toISOString() } : s
    ));
  }, []);

  // Update the current session data
  const updateCurrentSession = useCallback((updates: Partial<Session>) => {
    if (currentSessionId) {
      setSessions(prev => prev.map(s => 
        s.id === currentSessionId 
          ? { ...s, ...updates, updatedAt: new Date().toISOString() }
          : s
      ));
    }
  }, [currentSessionId]);

  // Upload a user avatar
  const handleAvatarUpload = async (file: File) => {
    setIsAvatarUploading(true);
    try {
      // Crop the image to a circle on a canvas
      const img = await createImageFromFile(file);
      const canvas = document.createElement('canvas');
      const size = 200; // Output size
      canvas.width = size;
      canvas.height = size;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not create a canvas');

      // Centre crop
      const minDim = Math.min(img.width, img.height);
      const sx = (img.width - minDim) / 2;
      const sy = (img.height - minDim) / 2;
      
      // Draw the circular crop
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      
      ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
      
      // Store as base64
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      localStorage.setItem(USER_AVATAR_STORAGE_KEY, dataUrl);
      setUserAvatar(dataUrl);
    } catch (error) {
      console.error('Avatar upload failed:', error);
      alert('Avatar upload failed, please try again');
    } finally {
      setIsAvatarUploading(false);
    }
  };

  // Create an Image from a File
  const createImageFromFile = (file: File): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // Restore the default avatar
  const handleAvatarReset = () => {
    localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
    setUserAvatar(null);
  };

  // Smooth scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTo({
        top: scrollAreaRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, []);

  // Track scroll position to know when the list is at the bottom
  const handleScroll = useCallback(() => {
    if (scrollAreaRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollAreaRef.current;
      const isBottom = scrollHeight - scrollTop - clientHeight < 10; // 10px tolerance
      setIsAtBottom(isBottom);
    }
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollToBottom();
    setIsAtBottom(true);
  }, [messages, scrollToBottom]);

  // Send a message (runs in the background, supports multiple images)
  const sendMessage = async (content: string, imageUrl?: string, auxiliaryImages?: string[]) => {
    if (!content.trim() && !imageUrl) return;
    if (!currentSessionId) return; // Requires a current session

    // Cancel the session's previous running task to avoid duplicate requests
    const existingTask = backgroundTasksRef.current.get(currentSessionId);
    if (existingTask && existingTask.status === 'running') {
      console.log(`Cancelling the previous task for session ${currentSessionId}`);
      existingTask.abortController.abort();
      existingTask.status = 'cancelled';
    }

    // Read the target session's full state from the sessions array, not the live sessionState
    const targetSession = sessions.find(s => s.id === currentSessionId);
    if (!targetSession) return;
    
    // Use the target session's backend sessionId and state
    const targetBackendSessionId = targetSession.backendSessionId;
    const targetProductName = targetSession.state.productName;
    const targetSessionState = targetSession.state;
    const targetVoiceLanguage = targetSession.voiceLanguage || 'english'; // Target session's voiceover language
    const targetVideoRatio = targetSession.videoRatio || '16:9'; // Target session's video ratio

    // AbortController for cancelling the request
    const abortController = new AbortController();
    
    // Store the background task state
    const task: BackgroundTask = {
      sessionId: currentSessionId,
      abortController,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    backgroundTasksRef.current.set(currentSessionId, task);

    const sessionClientId = currentSessionId; // Session that initiated the request

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: imageUrl && auxiliaryImages?.length 
        ? `[Uploaded ${auxiliaryImages.length + 1} product images]`
        : (imageUrl ? '[Uploaded a product image]' : content),
      timestamp: new Date().toISOString(),
      imageUrl: imageUrl,
      auxiliaryImages: auxiliaryImages,
    };
    
    // Only update the visible message list if this session is still active
    if (currentSessionId === sessionClientId) {
      setMessages(prev => [...prev, userMessage]);
    }
    
    // Also update the session data for background persistence
    setSessions(prev => prev.map(s => 
      s.id === sessionClientId 
        ? { ...s, messages: [...s.messages, userMessage], updatedAt: new Date().toISOString() }
        : s
    ));
    
    setInputValue('');
    setIsLoading(true);
    
    // Generation or composition commands set isGenerating on the target session immediately
    if (content === 'Generate video segments' || content === 'Compose the final video') {
      // Only the target session changes; other sessions are untouched
      setSessions(prev => prev.map(s => 
        s.id === sessionClientId 
          ? { ...s, isGenerating: true, updatedAt: new Date().toISOString() }
          : s
      ));
    }

    const assistantMessage: ChatMessage = {
      id: `assistant_${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    };
    
    // Only update the visible message list if this session is still active
    if (currentSessionId === sessionClientId) {
      setMessages(prev => [...prev, assistantMessage]);
    }
    
    // Also update the session data for background persistence
    setSessions(prev => prev.map(s => 
      s.id === sessionClientId 
        ? { ...s, messages: [...s.messages, assistantMessage], updatedAt: new Date().toISOString() }
        : s
    ));

    try {
      console.log(`[frontend] request: sessionId=${targetBackendSessionId}, message=${content.substring(0, 50)}, scripts=${targetSessionState.scripts ? targetSessionState.scripts.length : 'none'}`);
      const response = await fetch('/api/chat-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: targetBackendSessionId, // Target session's backend sessionId
          message: content,
          imageUrl, // Main image URL
          auxiliaryImages, // Additional image URLs
          productName: targetProductName, // Target session's productName
          voiceLanguage: targetVoiceLanguage, // Target session's voiceover language
          scripts: targetSessionState.scripts, // Send scripts so video generation survives lost server state
          segments: targetSessionState.segments, // Send segments
          videoRatio: targetVideoRatio, // Video ratio from the session
        }),
        signal: abortController.signal, // AbortController signal
      });

      if (!response.ok) throw new Error('Request failed');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Could not read the response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.slice(6));

              // Key change: update the session matching sessionClientId
              // If it is the current session, update the live state too
              // currentSessionIdRef.current always holds the latest session ID regardless of render timing
              const isCurrentSession = sessionClientId === currentSessionIdRef.current;

              switch (eventData.type) {
                case 'text':
                  const textContent = eventData.content;
                  if (textContent.includes('<tool_call>') || 
                      textContent.match(/^[\s\n]*$/) ||
                      textContent.match(/^[{}\s":,]*$/)) {
                    break;
                  }
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const updatedMessages = s.messages.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + textContent }
                        : m
                    );
                    return { ...s, messages: updatedMessages, updatedAt: new Date().toISOString() };
                  }));
                  // Update live state if this is the current session
                  if (isCurrentSession) {
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === assistantMessage.id
                          ? { ...m, content: m.content + textContent }
                          : m
                      )
                    );
                  }
                  break;

                case 'progress':
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const updatedMessages = s.messages.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content ? `${m.content}\n${eventData.content}` : eventData.content }
                        : m
                    );
                    return { ...s, messages: updatedMessages, updatedAt: new Date().toISOString() };
                  }));
                  if (isCurrentSession) {
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === assistantMessage.id
                          ? { ...m, content: m.content ? `${m.content}\n${eventData.content}` : eventData.content }
                          : m
                      )
                    );
                  }
                  break;

                case 'tool_result':
                  // Two formats are supported:
                  // 1. Video generation: content holds the full object and segments live in content.data
                  // 2. Regular tool calls: data holds the payload, or content.data does
                  const trContentObj = eventData.content && typeof eventData.content === 'object' 
                    ? (eventData.content as Record<string, unknown>) 
                    : null;
                  const trDataObj = eventData.data as Record<string, unknown> | undefined;
                  
                  // Read toolData from content.data or data
                  const trOuterData = trContentObj || trDataObj;
                  const trToolData = (trOuterData?.data || trOuterData) as Record<string, unknown> || {};
                  
                  console.log('[frontend] tool_result event:', {
                    hasContentObj: !!trContentObj,
                    hasDataObj: !!trDataObj,
                    toolDataSegments: trToolData.segments ? (trToolData.segments as Array<unknown>).length : 0,
                    toolDataStage: trToolData.currentStage
                  });
                  
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const trMessageContent = typeof eventData.content === 'string' 
                      ? eventData.content 
                      : (trContentObj?.message as string || '');
                    const updatedMessages = s.messages.map(m =>
                      m.id === assistantMessage.id
                        ? {
                            ...m,
                            content: m.content ? `${m.content}\n${trMessageContent}` : trMessageContent,
                            state: { ...m.state, ...trToolData },
                          }
                        : m
                    );
                    // Auto-title: when productName first appears and the title is still the default, use the product name
                    let newTitle = s.title;
                    if (trToolData.productName && (s.title === 'New chat' || s.title.startsWith('New chat'))) {
                      newTitle = trToolData.productName as string;
                    }
                    return { ...s, title: newTitle, messages: updatedMessages, state: { ...s.state, ...trToolData }, updatedAt: new Date().toISOString() };
                  }));
                  if (isCurrentSession) {
                    const trMessageContent2 = typeof eventData.content === 'string' 
                      ? eventData.content 
                      : (trContentObj?.message as string || '');
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === assistantMessage.id
                          ? {
                              ...m,
                              content: m.content ? `${m.content}\n${trMessageContent2}` : trMessageContent2,
                              state: { ...m.state, ...trToolData },
                            }
                          : m
                      )
                    );
                    setSessionState(prev => ({ ...prev, ...trToolData }));
                  }
                  break;

                case 'state_update':
                  const newBackendSessionId = eventData.sessionId;
                  // Check both content and data for compatibility
                  const stateData = eventData.data || eventData.content as Record<string, unknown> || {};
                  
                  // Verbose log: inspect segments
                  const newSegments = stateData.segments as Array<{id?: number; videoUrl?: string; script?: string}> | undefined;
                  console.log('[frontend] state_update event:', {
                    currentStage: stateData.currentStage,
                    segmentsCount: newSegments?.length || 0,
                    segmentsDetail: newSegments?.map(seg => ({id: seg.id, hasVideo: !!seg.videoUrl, videoUrl: seg.videoUrl?.substring(0, 30)}))
                  });
                  
                  // Update session data (store the backend session ID)
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    
                    // Find the target message
                    const targetMsgIdx = s.messages.findIndex(m => m.id === assistantMessage.id);
                    if (targetMsgIdx === -1) return s;
                    const targetMsg = s.messages[targetMsgIdx];
                    
                    // Merge segments, keeping existing videoUrl values
                    const oldSegments = targetMsg.state?.segments || [];
                    let mergedSegments = newSegments || oldSegments;
                    
                    if (newSegments && newSegments.length > 0) {
                      // Merge old and new segments, keeping existing videoUrl values
                      mergedSegments = newSegments.map(newSeg => {
                        const oldSeg = oldSegments.find(seg => seg.id === newSeg.id);
                        // Keep the old videoUrl when the new segment has none
                        if (!newSeg.videoUrl && oldSeg?.videoUrl) {
                          console.log(`[frontend] state_update merge: segment ${newSeg.id} keeps its videoUrl`);
                          return { ...newSeg, videoUrl: oldSeg.videoUrl, audioUrl: oldSeg.audioUrl, duration: oldSeg.duration };
                        }
                        return newSeg;
                      });
                      console.log('[frontend] state_update merged segments:', mergedSegments.map(seg => ({id: seg.id, hasVideo: !!seg.videoUrl})));
                    }
                    
                    // Build the new state from the merged segments
                    const mergedStateData = { ...stateData, segments: mergedSegments };
                    
                    const updatedMessages = s.messages.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, state: { ...m.state, ...mergedStateData } }
                        : m
                    );
                    // Auto-title: when productName first appears and the title is still the default, use the product name
                    let newTitle = s.title;
                    if (stateData.productName && (s.title === 'New chat' || s.title.startsWith('New chat'))) {
                      newTitle = stateData.productName;
                    }
                    return { 
                      ...s, 
                      title: newTitle,
                      messages: updatedMessages, 
                      state: { ...s.state, ...mergedStateData },
                      backendSessionId: newBackendSessionId,
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setSessionId(newBackendSessionId);
                    setMessages(prev => {
                      const targetMsgIdx = prev.findIndex(m => m.id === assistantMessage.id);
                      if (targetMsgIdx === -1) return prev;
                      const targetMsg = prev[targetMsgIdx];
                      
                      // Merge segments, keeping existing videoUrl values
                      const oldSegments = targetMsg.state?.segments || [];
                      let mergedSegments = newSegments || oldSegments;
                      
                      if (newSegments && newSegments.length > 0) {
                        mergedSegments = newSegments.map(newSeg => {
                          const oldSeg = oldSegments.find(seg => seg.id === newSeg.id);
                          if (!newSeg.videoUrl && oldSeg?.videoUrl) {
                            console.log(`[frontend] state_update merge: segment ${newSeg.id} keeps its videoUrl`);
                            return { ...newSeg, videoUrl: oldSeg.videoUrl, audioUrl: oldSeg.audioUrl, duration: oldSeg.duration };
                          }
                          return newSeg;
                        });
                      }
                      
                      const mergedStateData = { ...stateData, segments: mergedSegments };
                      return prev.map(m =>
                        m.id === assistantMessage.id
                          ? { ...m, state: { ...m.state, ...mergedStateData } }
                          : m
                      );
                    });
                    // Merge segments in sessionState
                    setSessionState(prev => {
                      const oldSegments = prev.segments || [];
                      let mergedSegments = newSegments || oldSegments;
                      
                      if (newSegments && newSegments.length > 0) {
                        mergedSegments = newSegments.map(newSeg => {
                          const oldSeg = oldSegments.find(seg => seg.id === newSeg.id);
                          if (!newSeg.videoUrl && oldSeg?.videoUrl) {
                            return { ...newSeg, videoUrl: oldSeg.videoUrl, audioUrl: oldSeg.audioUrl, duration: oldSeg.duration };
                          }
                          return newSeg;
                        });
                      }
                      
                      return { ...prev, ...stateData, segments: mergedSegments };
                    });
                  }
                  break;

                case 'wait_feedback':
                  // Two formats are supported:
                  // 1. Video generation: content holds the state
                  // 2. Regular tool calls: data.state holds the state
                  const wfContentObj = eventData.content && typeof eventData.content === 'object' 
                    ? (eventData.content as Record<string, unknown>) 
                    : null;
                  const wfDataObj = eventData.data as Record<string, unknown> | undefined;
                  
                  // Read feedbackState from content.state or data.state
                  const feedbackState = (wfContentObj?.state || wfDataObj?.state) as Partial<SessionState> || {};
                  
                  console.log('[frontend] wait_feedback event:', {
                    hasContentObj: !!wfContentObj,
                    hasDataObj: !!wfDataObj,
                    feedbackStateSegments: feedbackState.segments?.length || 0,
                    feedbackStateStage: feedbackState.currentStage
                  });
                  
                  if (feedbackState.segments) {
                    console.log('[frontend] wait_feedback segment count:', feedbackState.segments.length);
                    console.log('[frontend] wait_feedback segments:', feedbackState.segments.map(s => ({ id: s.id, hasVideo: !!s.videoUrl })));
                  }
                  
                  // Update session data, merging segments to keep videoUrl values
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const updatedMessages = s.messages.map(m => {
                      if (m.id !== assistantMessage.id) return m;
                      const oldState = m.state || {};
                      const oldSegments = oldState.segments || [];
                      const wfNewSegments = feedbackState.segments || [];
                      // Merge segments, keeping existing videoUrl values
                      const mergedSegments: SessionState['segments'] = wfNewSegments.map(newSeg => {
                        const oldSeg = oldSegments.find(seg => seg.id === newSeg.id);
                        if (!newSeg.videoUrl && oldSeg?.videoUrl) {
                          console.log(`[frontend] wait_feedback merge: segment ${newSeg.id} keeps its videoUrl`);
                          return { ...newSeg, videoUrl: oldSeg.videoUrl, audioUrl: oldSeg.audioUrl, duration: oldSeg.duration };
                        }
                        return newSeg;
                      });
                      return { ...m, state: { ...oldState, ...feedbackState, segments: mergedSegments }, isStreaming: false };
                    });
                    return { 
                      ...s, 
                      messages: updatedMessages, 
                      state: { ...s.state, ...feedbackState },
                      isGenerating: false,
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setMessages(prev =>
                      prev.map(m => {
                        if (m.id !== assistantMessage.id) return m;
                        const oldState = m.state || {};
                        const oldSegments = oldState.segments || [];
                        const wfSetMsgNewSegments = feedbackState.segments || [];
                        // Merge segments, keeping existing videoUrl values
                        const mergedSegments: SessionState['segments'] = wfSetMsgNewSegments.map(newSeg => {
                          const oldSeg = oldSegments.find(seg => seg.id === newSeg.id);
                          if (!newSeg.videoUrl && oldSeg?.videoUrl) {
                            console.log(`[frontend] wait_feedback setMessages merge: segment ${newSeg.id} keeps its videoUrl`);
                            return { ...newSeg, videoUrl: oldSeg.videoUrl, audioUrl: oldSeg.audioUrl, duration: oldSeg.duration };
                          }
                          return newSeg;
                        });
                        return { ...m, state: { ...oldState, ...feedbackState, segments: mergedSegments }, isStreaming: false };
                      })
                    );
                    setSessionState(prev => {
                      const oldSegments = prev.segments || [];
                      const wfSetStateNewSegments = feedbackState.segments || [];
                      // Merge segments, keeping existing videoUrl values
                      const mergedSegments: SessionState['segments'] = wfSetStateNewSegments.map(newSeg => {
                        const oldSeg = oldSegments.find(seg => seg.id === newSeg.id);
                        if (!newSeg.videoUrl && oldSeg?.videoUrl) {
                          console.log(`[frontend] wait_feedback setSessionState merge: segment ${newSeg.id} keeps its videoUrl`);
                          return { ...newSeg, videoUrl: oldSeg.videoUrl, audioUrl: oldSeg.audioUrl, duration: oldSeg.duration };
                        }
                        return newSeg;
                      });
                      return { ...prev, ...feedbackState, segments: mergedSegments };
                    });
                    setIsLoading(false);
                    // Only the target session's isGenerating becomes false
                    setSessions(prev => prev.map(s => 
                      s.id === sessionClientId 
                        ? { ...s, isGenerating: false, updatedAt: new Date().toISOString() }
                        : s
                    ));
                    setGenerationProgress(prev => ({
                      ...prev,
                      currentStage: 0,
                      stageName: '',
                    }));
                  }
                  // Update background task state
                  if (backgroundTasksRef.current.has(sessionClientId)) {
                    const currentTask = backgroundTasksRef.current.get(sessionClientId);
                    if (currentTask) {
                      currentTask.status = 'completed';
                    }
                  }
                  break;

                // Video generation progress event
                case 'generation_progress':
                  const progressData = eventData.data || {};
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const newProgress = {
                      currentStage: progressData.currentStage || s.progress.currentStage,
                      stageName: progressData.stageName || s.progress.stageName,
                      estimatedTime: progressData.estimatedTime,
                      segmentStatus: progressData.segmentStatus || s.progress.segmentStatus,
                    };
                    return { 
                      ...s, 
                      progress: newProgress,
                      isGenerating: progressData.isGenerating || s.isGenerating,
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setGenerationProgress(prev => ({
                      currentStage: progressData.currentStage || prev.currentStage,
                      stageName: progressData.stageName || prev.stageName,
                      estimatedTime: progressData.estimatedTime,
                      segmentStatus: progressData.segmentStatus || prev.segmentStatus,
                    }));
                    // isGenerating was already updated in setSessions
                  }
                  break;

                // Scene segment status update
                case 'segment_status':
                  const segId = eventData.segmentId;
                  const segStatus = eventData.status;
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const newSegmentStatus = {
                      ...s.progress.segmentStatus,
                      [segId]: segStatus,
                    };
                    return { 
                      ...s, 
                      progress: { ...s.progress, segmentStatus: newSegmentStatus },
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setGenerationProgress(prev => ({
                      ...prev,
                      segmentStatus: {
                        ...prev.segmentStatus,
                        [segId]: segStatus,
                      },
                    }));
                  }
                  break;

                // Scene segment video URL update: show each video as soon as it is ready
                case 'segment_video':
                  const videoSegId = eventData.content?.segmentId;
                  const videoSegUrl = eventData.content?.videoUrl;
                  const videoSegAudioUrl = eventData.content?.audioUrl;
                  const videoSegDuration = eventData.content?.duration;
                  console.log(`[frontend] segment_video event: segmentId=${videoSegId}, videoUrl=${videoSegUrl?.substring(0, 50)}`);
                  
                  // Ensure videoSegId is a number
                  const videoSegIdNum = typeof videoSegId === 'number' ? videoSegId : parseInt(videoSegId as string, 10);
                  console.log(`[frontend] videoSegId coerced: raw=${videoSegId}(${typeof videoSegId}), number=${videoSegIdNum}`);
                  
                  // Update the segments array in the session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    // Find the last assistant message (searching backwards) and update its segments
                    let lastAssistantIdx = -1;
                    for (let i = s.messages.length - 1; i >= 0; i--) {
                      if (s.messages[i].role === 'assistant') {
                        lastAssistantIdx = i;
                        break;
                      }
                    }
                    if (lastAssistantIdx === -1) {
                      console.log(`[frontend] segment_video: no assistant message found`);
                      return s;
                    }
                    const targetMsg = s.messages[lastAssistantIdx];
                    const existingSegments = targetMsg.state?.segments || [];
                    console.log(`[frontend] segment_video: existingSegments=${existingSegments.length}, ids=${existingSegments.map(seg => seg.id).join(',')}`);
                    
                    // Check for a matching segment
                    const matchedSegment = existingSegments.find(seg => seg.id === videoSegIdNum);
                    console.log(`[frontend] segment_video: match=${matchedSegment ? `id=${matchedSegment.id}` : 'none'}`);
                    
                    // Update the matching segment's videoUrl
                    const updatedSegments = existingSegments.map(seg => {
                      if (seg.id === videoSegIdNum) {
                        console.log(`[frontend] segment_video: updating videoUrl of segment ${seg.id}`);
                        return {
                          ...seg,
                          videoUrl: videoSegUrl,
                          audioUrl: videoSegAudioUrl,
                          duration: videoSegDuration,
                        };
                      }
                      return seg;
                    });
                    // Add the segment when it does not exist yet
                    if (!existingSegments.find(seg => seg.id === videoSegIdNum)) {
                      updatedSegments.push({
                        id: videoSegIdNum,
                        videoUrl: videoSegUrl,
                        audioUrl: videoSegAudioUrl,
                        duration: videoSegDuration,
                        script: eventData.content?.script || '',
                        prompt: '', // No prompt during video generation; state_update fills it in later
                      });
                    }
                    const updatedMessages = s.messages.map((m, idx) =>
                      idx === lastAssistantIdx
                        ? { ...m, state: { ...m.state, segments: updatedSegments } }
                        : m
                    );
                    return { 
                      ...s, 
                      messages: updatedMessages,
                      state: { ...s.state, segments: updatedSegments },
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setMessages(prev => {
                      // Find the last assistant message searching backwards (same as setSessions)
                      let lastAssistantIdx = -1;
                      for (let i = prev.length - 1; i >= 0; i--) {
                        if (prev[i].role === 'assistant') {
                          lastAssistantIdx = i;
                          break;
                        }
                      }
                      if (lastAssistantIdx === -1) return prev;
                      const targetMsg = prev[lastAssistantIdx];
                      const existingSegments = targetMsg.state?.segments || [];
                      console.log(`[frontend] segment_video setMessages: index=${lastAssistantIdx}, segments=${existingSegments.length}`);
                      const updatedSegments = existingSegments.map(seg => {
                        if (seg.id === videoSegIdNum) {
                          console.log(`[frontend] segment ${seg.id} videoUrl=${videoSegUrl ? 'set' : 'missing'}`);
                          return { ...seg, videoUrl: videoSegUrl, audioUrl: videoSegAudioUrl, duration: videoSegDuration };
                        }
                        return seg;
                      });
                      if (!existingSegments.find(seg => seg.id === videoSegIdNum)) {
                        updatedSegments.push({
                          id: videoSegIdNum,
                          videoUrl: videoSegUrl,
                          audioUrl: videoSegAudioUrl,
                          duration: videoSegDuration,
                          script: eventData.content?.script || '',
                          prompt: '', // No prompt during video generation; state_update fills it in later
                        });
                      }
                      return prev.map((m, idx) =>
                        idx === lastAssistantIdx
                          ? { ...m, state: { ...m.state, segments: updatedSegments } }
                          : m
                      );
                    });
                    setSessionState(prev => {
                      const existingSegments = prev.segments || [];
                      const updatedSegments = existingSegments.map(seg => {
                        if (seg.id === videoSegIdNum) {  // videoSegIdNum guarantees matching types
                          return { ...seg, videoUrl: videoSegUrl, audioUrl: videoSegAudioUrl, duration: videoSegDuration };
                        }
                        return seg;
                      });
                      if (!existingSegments.find(seg => seg.id === videoSegIdNum)) {  // videoSegIdNum
                        updatedSegments.push({
                          id: videoSegIdNum,
                          videoUrl: videoSegUrl,
                          audioUrl: videoSegAudioUrl,
                          duration: videoSegDuration,
                          script: eventData.content?.script || '',
                          prompt: '',
                        });
                      }
                      console.log(`[frontend] segment_video setSessionState: segments=${updatedSegments.length}, withVideo=${updatedSegments.filter(s => s.videoUrl).length}`);
                      return { ...prev, segments: updatedSegments };
                    });
                  }
                  break;

                case 'complete':
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const updatedMessages = s.messages.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, isStreaming: false }
                        : m
                    );
                    return { 
                      ...s, 
                      messages: updatedMessages, 
                      isGenerating: false,
                      progress: { ...s.progress, currentStage: 0, stageName: '' },
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === assistantMessage.id
                          ? { ...m, isStreaming: false }
                          : m
                      )
                    );
                    setIsLoading(false);
                    // isGenerating was already set to false in setSessions
                    setGenerationProgress(prev => ({
                      ...prev,
                      currentStage: 0,
                      stageName: '',
                    }));
                  }
                  // Update background task state
                  if (backgroundTasksRef.current.has(sessionClientId)) {
                    const currentTask = backgroundTasksRef.current.get(sessionClientId);
                    if (currentTask) {
                      currentTask.status = 'completed';
                    }
                  }
                  break;

                case 'error':
                  // Update session data
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sessionClientId) return s;
                    const updatedMessages = s.messages.map(m =>
                      m.id === assistantMessage.id
                        ? {
                            ...m,
                            content: `Error: ${eventData.content}`,
                            isStreaming: false,
                          }
                        : m
                    );
                    return { 
                      ...s, 
                      messages: updatedMessages, 
                      isGenerating: false,
                      updatedAt: new Date().toISOString() 
                    };
                  }));
                  if (isCurrentSession) {
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === assistantMessage.id
                          ? {
                              ...m,
                              content: `Error: ${eventData.content}`,
                              isStreaming: false,
                            }
                          : m
                      )
                    );
                    setIsLoading(false);
                  }
                  // Update background task state
                  if (backgroundTasksRef.current.has(sessionClientId)) {
                    const currentTask = backgroundTasksRef.current.get(sessionClientId);
                    if (currentTask) {
                      currentTask.status = 'failed';
                    }
                  }
                  break;
              }
            } catch {
              // Ignore parse failures
            }
          }
        }
      }
    } catch (error) {
      // Do not show an error for deliberate cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Request cancelled');
        return;
      }
      
      console.error('Failed to send message:', error);
      
      // Update session data
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionClientId) return s;
        const updatedMessages = s.messages.map(m =>
          m.id === assistantMessage.id
            ? {
                ...m,
                content: `Sorry, something went wrong: ${error instanceof Error ? error.message : 'Unknown error'}`,
                isStreaming: false,
              }
            : m
        );
        return { 
          ...s, 
          messages: updatedMessages, 
          isGenerating: false,
          updatedAt: new Date().toISOString() 
        };
      }));
      
      // Use the ref for the latest current session ID
      if (sessionClientId === currentSessionIdRef.current) {
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantMessage.id
              ? {
                  ...m,
                  content: `Sorry, something went wrong: ${error instanceof Error ? error.message : 'Unknown error'}`,
                  isStreaming: false,
                }
              : m
          )
        );
        setIsLoading(false);
      }
      
      // Update background task state
      if (backgroundTasksRef.current.has(sessionClientId)) {
        const currentTask = backgroundTasksRef.current.get(sessionClientId);
        if (currentTask) {
          currentTask.status = 'failed';
        }
      }
    }
  };

  // Upload images to the staging area (no auto-send, multi-select)
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      console.log('No files selected');
      return;
    }

    console.log(`Uploading ${files.length} images`);
    setIsLoading(true);

    // Upload all files in parallel
    const uploadPromises = Array.from(files).map(async (file) => {
      console.log('Uploading image:', file.name, file.type, file.size);
      const formData = new FormData();
      formData.append('file', file);

      try {
        const response = await fetch('/api/upload-image', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error('Upload failed:', errorData);
          return null;
        }

        const data = await response.json();
        console.log('Upload succeeded, imageUrl:', data.imageUrl);
        
        // Create a thumbnail
        const thumbnail = await createThumbnail(file);
        
        return {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          imageUrl: data.imageUrl,
          thumbnail
        };
      } catch (error) {
        console.error('Image upload failed:', file.name, error);
        return null;
      }
    });

    try {
      const results = await Promise.all(uploadPromises);
      const successfulImages = results.filter((img): img is { id: string; imageUrl: string; thumbnail: string } => img !== null);
      
      if (successfulImages.length > 0) {
        setPendingImages(prev => [...prev, ...successfulImages]);
        console.log(`Added ${successfulImages.length} images to the staging area`);
      }
      
      if (successfulImages.length < files.length) {
        console.warn(`${files.length - successfulImages.length} images failed to upload`);
      }
    } catch (error) {
      console.error('Batch upload error:', error);
    }
    
    setIsLoading(false);
    
    // Reset the input so the same file can be selected again
    e.target.value = '';
  };

  // Create an image thumbnail
  const createThumbnail = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        resolve(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    });
  };

  // Remove a staged image
  const removePendingImage = (id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  };

  // Send staged images for recognition (main image + additional images)
  const sendPendingImages = () => {
    if (pendingImages.length === 0) return;
    
    // The first image is the main image; the rest are supporting images
    const mainImage = pendingImages[0];
    const auxiliaryImageUrls = pendingImages.length > 1 
      ? pendingImages.slice(1).map(img => img.imageUrl) 
      : undefined;
    
    // Send all images for product recognition
    sendMessage('Please analyse these product images, identify the product and extract its selling points. The first image is the main image; the others are supporting images. Consider all of them together.', mainImage.imageUrl, auxiliaryImageUrls);
    
    // Clear the staging area
    setPendingImages([]);
  };

  // Clear the session
  const clearSession = async () => {
    if (sessionId) {
      await fetch(`/api/chat-agent?sessionId=${sessionId}`, { method: 'DELETE' });
    }
    setSessionId(undefined);
    setSessionState({});
    setMessages([
      {
        id: 'welcome_new',
        role: 'assistant',
        content: 'Session cleared. Upload a new product image to start a new project!',
        timestamp: new Date().toISOString(),
      },
    ]);
  };

  // Render assistant message content
  const renderAssistantContent = (message: ChatMessage) => {
    const msgState = message.state || {};

    // Final video
    if (msgState.finalVideoUrl || msgState.localVideoPath) {
      const videoSrc = msgState.localVideoPath || getAccessibleUrl(msgState.finalVideoUrl || '');
      const videoRatio = (msgState.videoRatio === '9:16' ? '9:16' : '16:9') as '16:9' | '9:16';
      return (
        <div className="space-y-3">
          <p className="text-sm">{filterSystemCommands(message.content)}</p>
          <div className="bg-white rounded-xl p-3 shadow-sm">
            <VideoPlayer videoUrl={msgState.finalVideoUrl} localVideoPath={msgState.localVideoPath} ratio={videoRatio} size="final" />
            <div className="mt-2 flex gap-2">
              <button
                onClick={async () => {
                  try {
                    const response = await fetch(videoSrc);
                    const blob = await response.blob();
                    const blobUrl = window.URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = blobUrl;
                    link.download = `vidio_${new Date().toISOString().slice(0,10)}.mp4`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    window.URL.revokeObjectURL(blobUrl);
                  } catch (error) {
                    console.error('Download failed:', error);
                    window.open(videoSrc, '_blank');
                  }
                }}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B999F3] text-white rounded-lg text-sm hover:bg-[#D4C2F6] transition-colors"
              >
                <Download className="w-4 h-4" />
                Download video
              </button>
              <Button variant="outline" size="sm" onClick={clearSession}>
                Start a new project
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // Script content (with segment previews)
    if (msgState.scripts && msgState.scripts.length > 0 || msgState.segments && msgState.segments.length > 0) {
      // Whether any segment has a valid videoUrl
      const hasVideoSegments = msgState.segments && 
        msgState.segments.length > 0 && 
        msgState.segments.some(seg => seg.videoUrl && seg.videoUrl.length > 0);
      // Whether video generation is in progress
      const isVideoGenerating = msgState.currentStage === 'video_generating';
      // Whether everything is done
      const isDone = msgState.currentStage === 'done';
      
      // Debug log: hasVideoSegments and segments
      console.log('[render] hasVideoSegments =', hasVideoSegments);
      console.log('[render] segment count =', msgState.segments?.length);
      console.log('[render] segments =', msgState.segments?.map(s => ({ id: s.id, hasVideo: !!s.videoUrl, videoUrlLength: s.videoUrl?.length || 0 })));
      console.log('[render] currentStage =', msgState.currentStage);
      
      // While generating, show progress instead of the script
      if (isVideoGenerating && !hasVideoSegments) {
        return (
          <div className="space-y-3">
            <p className="text-sm">{filterSystemCommands(message.content)}</p>
            
            {/* Product card */}
            {msgState.productName && (
              <Card className="bg-white shadow-sm max-w-[600px]">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="secondary" className="bg-[#ECE6F7] text-[#333333]">Product</Badge>
                    <span className="font-medium text-sm">{msgState.productName}</span>
                  </div>
                  {msgState.features && msgState.features.length > 0 && (
                    <div className="text-xs text-[#666666]">
                      <span className="font-medium">Key selling points:</span>
                      {msgState.features.join('、')}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            
            {/* Video generation progress */}
            <div className="flex items-center gap-2 text-sm text-[#666666]">
              <Loader2 className="h-4 w-4 animate-spin text-[#B999F3]" />
              <span>Generating {msgState.segments?.length || 4} video segments, please wait...</span>
            </div>
            
            {/* Completed segment previews (live) */}
            {msgState.segments && msgState.segments.length > 0 && (
              <div className="grid grid-cols-2 gap-4 mt-4">
                {msgState.segments
                  .filter(seg => seg.videoUrl && seg.videoUrl.length > 0)
                  .map(segment => {
                    const segVideoRatio = (msgState.videoRatio === '9:16' ? '9:16' : '16:9') as '16:9' | '9:16';
                    // Portrait: keep 9:16, 180px wide (about 320px tall)
                    const segAspectClass = segVideoRatio === '9:16' ? 'aspect-[9/16] w-[180px]' : 'aspect-video';
                    return (
                    <div key={segment.id} className="bg-white rounded-xl shadow-md overflow-hidden">
                      <div className={`relative ${segAspectClass} bg-gray-900`}>
                        <VideoPlayer videoUrl={segment.videoUrl} ratio={segVideoRatio} size="segment" />
                      </div>
                      <div className="p-3">
                        <p className="text-xs text-[#666666] line-clamp-2">{segment.script}</p>
                      </div>
                    </div>
                  );})}
              </div>
            )}
          </div>
        );
      }
      
      // Normal render: script and/or video segments
      return (
        <div className="space-y-3">
          <p className="text-sm">{filterSystemCommands(message.content)}</p>
          
          {/* Product card */}
          {msgState.productName && (
            <Card className="bg-white shadow-sm max-w-[600px]">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="bg-[#ECE6F7] text-[#333333]">Product</Badge>
                  <span className="font-medium text-sm">{msgState.productName}</span>
                </div>
                {msgState.features && msgState.features.length > 0 && (
                  <div className="text-xs text-[#666666]">
                    <span className="font-medium">Key selling points:</span>
                    {msgState.features.join('、')}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          
          {/* Full workflow progress */}
          <ProgressTracker
            currentStage={generationProgress.currentStage}
            stageName={generationProgress.stageName}
            estimatedTime={generationProgress.estimatedTime}
            isGenerating={isGenerating}
          />
          
          {/* Segment grid, shown when segments exist */}
          {hasVideoSegments && (
            <div className="space-y-2 mb-4">
              <div className="text-xs text-[#666666] p-2 bg-[#ECE6F7] rounded-lg">
                🎬 Video segments are ready. Use the button below to compose the final video
              </div>
              <div className="grid gap-4" style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              }}>
                {(msgState.segments || [])
                  .sort((a, b) => (a.id || 0) - (b.id || 0))
                  .map((segment, index) => {
                    const segVideoRatio = (msgState.videoRatio === '9:16' ? '9:16' : '16:9') as '16:9' | '9:16';
                    // Portrait: keep 9:16, 180px wide (about 320px tall)
                    const segAspectClass = segVideoRatio === '9:16' ? 'aspect-[9/16] w-[180px]' : 'aspect-video';
                    return (
                    <div key={`segment-${segment.id || index}-${segment.videoUrl || segment.localVideoPath || 'no-video'}`} className="bg-white rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow">
                      {/* Video preview, sized by ratio */}
                      <div className={`relative ${segAspectClass} bg-gray-900 group`}>
                        <VideoPlayer
                          videoUrl={segment.videoUrl}
                          localVideoPath={segment.localVideoPath}
                          audioUrl={segment.audioUrl}
                          showControls={true}
                          ratio={segVideoRatio}
                          size="segment"
                        />
                      </div>
                      {/* Script and actions */}
                      <div className="p-3 bg-[#F1F3F5]">
                        <Badge variant="outline" className="mb-2 text-xs border-[#D4C2F6] text-[#B999F3]">Segment {segment.id}</Badge>
                        <p className="text-sm text-[#333333] mt-1 line-clamp-2 leading-relaxed">{segment.script}</p>
                      </div>
                    </div>
                  );})}
              </div>
            </div>
          )}
          
          {/* Scene cards, shown when there is a script but no video yet */}
          {!hasVideoSegments && msgState.scripts && msgState.scripts.length > 0 && (
            <>
              {/* Scene sequence intro */}
              <div className="text-xs text-[#666666] mb-3 p-2 bg-[#ECE6F7] rounded-lg">
                📹 Here is your scene sequence. Edit the scene descriptions and voiceover, reorder scenes or redo a single scene, then generate the full video
              </div>
              
              {/* Scene cards: left timeline, stacked vertically */}
              <div className="relative pl-8 py-2">
                {/* Vertical timeline */}
                <div className="absolute left-3 top-2 bottom-2 w-0.5 bg-[#D4C2F6]" />
                {/* Timeline nodes */}
                {msgState.scripts.map((script, index) => (
                  <div key={script.id} className="relative mb-6 last:mb-2">
                    {/* Node dot */}
                    <div className="absolute -left-5 top-4 w-3 h-3 rounded-full bg-[#B999F3] border-2 border-white shadow" />
                    
                    {/* Scene card */}
                    <ScriptCard
                      script={script}
                      index={index}
                      total={msgState.scripts?.length || 0}
                      segmentStatus={generationProgress.segmentStatus[script.id] || 'pending'}
                      isGenerating={isGenerating}
                      onEdit={(field: 'script' | 'prompt', value: string) => {
                        // Update the script text
                        const updatedScripts = msgState.scripts?.map(s => 
                          s.id === script.id ? { ...s, [field]: value } : s
                        ) || [];
                        setSessionState(prev => ({
                          ...prev,
                          scripts: updatedScripts
                        }));
                      }}
                      onRegenerate={() => sendMessage(`Regenerate scene ${script.id}`)}
                      onMoveUp={index > 0 ? () => {
                        const newScripts = [...(msgState.scripts || [])];
                        [newScripts[index - 1], newScripts[index]] = [newScripts[index], newScripts[index - 1]];
                        setSessionState(prev => ({ ...prev, scripts: newScripts }));
                      } : undefined}
                      onMoveDown={index < (msgState.scripts?.length || 0) - 1 ? () => {
                        const newScripts = [...(msgState.scripts || [])];
                        [newScripts[index], newScripts[index + 1]] = [newScripts[index + 1], newScripts[index]];
                        setSessionState(prev => ({ ...prev, scripts: newScripts }));
                      } : undefined}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
          
          {/* Shared action buttons */}
          {!isDone && (
            <div className="mt-4 p-3 bg-white rounded-lg shadow-sm border border-[#E5E5E5]">
              {/* The video ratio is chosen on the session card, so it is not repeated here */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#666666]">
                  {isGenerating ? 'Generating, please wait...' :
                    hasVideoSegments 
                      ? 'Video segments are ready; compose the final video'
                      : 'Review every scene, then generate the video segments'}
                </span>
                <Button
                  size="sm"
                  className="bg-[#B999F3] hover:bg-[#D4C2F6] text-white disabled:bg-gray-300 disabled:text-gray-500"
                  onClick={() => sendMessage(
                    hasVideoSegments 
                      ? '[COMPOSE_VIDEO] Compose all video segments into the final video with background music and subtitles.'
                      : '[GENERATE_SEGMENTS] Generate the video segments from the script, each with voiceover and visuals.'
                  )}
                  disabled={
                    isGenerating || 
                    // "Generate video segments" is only available in the script_generated stage
                    (!hasVideoSegments && msgState.currentStage !== 'script_generated') ||
                    // "Compose the final video" is only available in the video_generated stage
                    (hasVideoSegments && msgState.currentStage !== 'video_generated')
                  }
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      Generating...
                    </>
                  ) : (
                    hasVideoSegments 
                      ? '🎬 Compose the final video'
                      : '🎥 Generate video segments'
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Product recognition result
    if (msgState.productName && !msgState.scripts) {
      return (
        <div className="space-y-3">
          <p className="text-sm">{filterSystemCommands(message.content)}</p>
          <Card className="bg-white shadow-sm max-w-[600px]">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary" className="bg-[#ECE6F7] text-[#B999F3]">Product</Badge>
                <span className="font-medium text-sm">{msgState.productName}</span>
              </div>
              {msgState.features && msgState.features.length > 0 && (
                <div className="text-xs text-[#666666]">
                  <span className="font-medium">Key selling points:</span>
                  {msgState.features.join('、')}
                </div>
              )}
            </CardContent>
          </Card>
          <Button
            size="sm"
            className="bg-[#B999F3] hover:bg-[#D4C2F6] text-white disabled:bg-gray-300 disabled:text-gray-500"
            onClick={() => sendMessage('Write the promotional script from the product information')}
            disabled={isLoading || isGenerating || (msgState.currentStage && ['script_generated', 'video_generated', 'composing', 'done'].includes(msgState.currentStage))}
          >
            Write the script
          </Button>
        </div>
      );
    }

    // Default text
    return <p className="text-sm whitespace-pre-wrap">{filterSystemCommands(message.content)}</p>;
  };

  // Render a single message
  // Whether the message is plain text (no structured data)
  const isPlainTextMessage = (message: ChatMessage) => {
    const msgState = message.state || {};
    // Product info, scripts, segments or a final video make it structured
    return !msgState.productName && 
           !msgState.scripts?.length && 
           !msgState.segments?.length && 
           !msgState.finalVideoUrl && 
           !msgState.localVideoPath;
  };

  // Render a single message
  const renderMessage = (message: ChatMessage) => {
    const isPlainText = isPlainTextMessage(message);
    
    if (message.role === 'user') {
      // User message: avatar on the right
      return (
        <div key={message.id} className="flex justify-end items-start gap-2 mb-3">
          {/* Message bubble */}
          <div className="max-w-[72%] bg-[#B999F3] text-white rounded-2xl rounded-tr-md px-4 py-2.5 shadow-sm">
            {/* Multiple images: main image + supporting images */}
            {(message.imageUrl || message.auxiliaryImages?.length) && (
              <div className="flex gap-2 mb-2 flex-wrap">
                {/* Main image */}
                {message.imageUrl && (
                  <div className="relative">
                    <img 
                      src={message.imageUrl} 
                      alt="Main image"
                      className="w-24 h-24 rounded-lg object-cover border-2 border-white/80"
                    />
                    <span className="absolute top-1 right-1 bg-[#B999F3] text-white text-[10px] px-1 rounded shadow-sm">Main</span>
                  </div>
                )}
                {/* Supporting images */}
                {message.auxiliaryImages?.map((auxUrl, idx) => (
                  <div key={idx} className="relative">
                    <img 
                      src={auxUrl} 
                      alt={`Supporting image ${idx + 1}`}
                      className="w-24 h-24 rounded-lg object-cover border border-white/50"
                    />
                    <span className="absolute top-1 right-1 bg-[#666666]/70 text-white text-[10px] px-1 rounded shadow-sm">{idx + 1}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-sm">{filterSystemCommands(message.content)}</p>
            <p className="text-xs text-[#D4C2F6] mt-1 text-right">
              <ClientTime timestamp={message.timestamp} />
            </p>
          </div>
          {/* User avatar, plain-text messages only */}
          {isPlainText && (
            <div className="w-8 h-8 rounded-full overflow-hidden bg-gray-300 flex items-center justify-center shadow-sm shrink-0 ring-2 ring-white/50">
              {userAvatar ? (
                <img 
                  src={userAvatar} 
                  alt="User avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <User className="w-4 h-4 text-gray-500" />
              )}
            </div>
          )}
        </div>
      );
    }

    // Agent message: avatar on the left
    return (
      <div key={message.id} className="flex justify-start items-start gap-2 mb-3">
        {/* Agent avatar, plain-text messages only */}
        {isPlainText && (
          <NextImage
            src="/assets/agent-avatar.png" 
            alt="vidio"
            width={32}
            height={32}
            className="w-8 h-8 rounded-full object-cover shadow-sm shrink-0 ring-2 ring-white/50"
          />
        )}
        {/* Message bubble */}
        <div className="max-w-[72%] bg-[#F1F3F5] text-[#333333] rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm">
          {/* Agent name label, plain-text messages only */}
          {isPlainText && (
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-xs font-medium text-[#B999F3]">vidio</span>
            </div>
          )}
          
          {/* Content */}
          {message.isStreaming && !message.content ? (
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-[#B999F3]" />
              <span className="text-sm text-[#666666]">Thinking...</span>
            </div>
          ) : (
            renderAssistantContent(message)
          )}
          
          <p className="text-xs text-[#999999] mt-2">
            <ClientTime timestamp={message.timestamp} />
          </p>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Full-screen background */}
      <div className="fixed inset-0 bg-[#F8F7F5]" />
      <a href="/studio" className="fixed top-3 right-4 z-50 rounded-full bg-[#7543cf] px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-[#6332b8]">Open the safe studio demo →</a>
      
      {/* Two-column layout */}
      <div 
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl shadow-lg overflow-hidden flex"
        style={{
          width: 'calc(82vw + 260px)',
          minWidth: '840px',
          maxWidth: '1460px',
          height: isCollapsed ? '56px' : '88vh',
          minHeight: isCollapsed ? '56px' : '480px',
          maxHeight: isCollapsed ? '56px' : '92vh',
          transition: 'height 0.3s ease',
        }}
      >
        {/* Left session sidebar, 260px */}
        {!isCollapsed && (
          <SessionSidebar
            sessions={sessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
            onUpdateSessionVoiceLanguage={updateSessionVoiceLanguage}
            onUpdateSessionVideoRatio={updateSessionVideoRatio}
          />
        )}
        
        {/* Right chat window */}
        <div className="flex-1 flex flex-col" style={{ width: isCollapsed ? '100%' : 'calc(100% - 260px)' }}>
          {/* Top bar, fixed 56px */}
          <div className="h-[56px] bg-gradient-to-r from-[#F5E6D3] to-[#FFFFFF] flex items-center justify-between px-4 shrink-0 border-b border-[#E5E5E5]">
            {/* Show the vidio logo when collapsed */}
            {isCollapsed && (
              <div className="flex items-center gap-3">
                <NextImage
                  src="/assets/agent-avatar.png" 
                  alt="vidio"
                  width={48}
                  height={48}
                  className="w-12 h-12 rounded-full object-cover border-2 border-[#D4C2F6] shadow-sm"
                />
                <div className="flex flex-col">
                  <span className="text-[#333333] font-semibold text-lg">vidio</span>
                  <span className="text-[#666666] text-sm">Product video assistant</span>
                </div>
              </div>
            )}
            {/* Left side stays empty when expanded */}
            {!isCollapsed && <div />}
            
            {/* User avatar + collapse button */}
            <div className="flex items-center gap-3">
              {/* User avatar */}
              <UserAvatar
                avatarUrl={userAvatar}
                onUpload={handleAvatarUpload}
                onReset={handleAvatarReset}
                isUploading={isAvatarUploading}
              />
              
              {/* Collapse button */}
              <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="p-2 hover:bg-[#F1F3F5] rounded-lg transition-colors"
                title={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? (
                  <ChevronUp className="w-5 h-5 text-[#7A7A7A]" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-[#7A7A7A]" />
                )}
              </button>
            </div>
          </div>
          
          {/* Chat area, flexible height */}
          {!isCollapsed && (
            <div 
              ref={scrollAreaRef}
              className="flex-1 min-h-0 bg-[#F8F7F5] overflow-y-auto p-4 relative"
              style={{ overflowX: 'hidden' }}
              onScroll={handleScroll}
            >
              {messages.map(renderMessage)}
              
              {/* Loading indicator */}
              {isLoading && messages[messages.length - 1]?.isStreaming && messages[messages.length - 1]?.content && (
                <div className="flex justify-start mb-3">
                  <div className="bg-[#F1F3F5] rounded-2xl px-4 py-2 shadow-sm">
                    <Loader2 className="w-4 h-4 animate-spin text-[#B999F3]" />
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* Product image staging area */}
          {!isCollapsed && pendingImages.length > 0 && (
            <div className="px-4 py-3 bg-[#F8F7F5] border-t border-[#E5E5E5]">
              <div className="flex items-center gap-2 mb-2">
                <ImageIcon className="w-4 h-4 text-[#7A7A7A]" />
                <span className="text-sm text-[#666666]">Product images</span>
                <span className="text-xs text-[#999999]">({pendingImages.length})</span>
                {pendingImages.length > 1 && (
                  <span className="text-xs text-[#B999F3]">· the first image is the main image</span>
                )}
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                {pendingImages.map((img, index) => (
                  <div 
                    key={img.id} 
                    className="relative group cursor-pointer"
                    onClick={() => {
                      // Click to make this the main image (move it first)
                      if (index > 0) {
                        const newImages = [...pendingImages];
                        const clickedImg = newImages.splice(index, 1)[0];
                        newImages.unshift(clickedImg);
                        setPendingImages(newImages);
                      }
                    }}
                    title={index === 0 ? 'Main image (primary reference)' : `Supporting image ${index} (click to make main)`}
                  >
                    <img 
                      src={img.thumbnail || img.imageUrl} 
                      alt={index === 0 ? 'Main image' : `Supporting image ${index}`}
                      className={`w-16 h-16 rounded-lg object-cover ${
                        index === 0 
                          ? 'border-2 border-[#B999F3] ring-2 ring-[#D4C2F6]/30' 
                          : 'border border-[#E5E5E5]'
                      }`}
                    />
                    {/* Main/supporting badge, top-right corner */}
                    <div className={`absolute top-0.5 right-0.5 px-1 rounded text-[10px] font-medium shadow-sm ${
                      index === 0 
                        ? 'bg-[#B999F3] text-white' 
                        : 'bg-[#666666]/70 text-white'
                    }`}>
                      {index === 0 ? 'Main' : `${index}`}
                    </div>
                    {/* Remove button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removePendingImage(img.id);
                      }}
                      className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <Button
                  size="sm"
                  className="h-8 px-3 bg-[#B999F3] hover:bg-[#D4C2F6] text-white text-xs"
                  onClick={sendPendingImages}
                  disabled={isLoading}
                >
                  Identify product
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs text-[#666666] border-[#E5E5E5]"
                  onClick={() => setPendingImages([])}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}
          
          {/* Bottom input bar, fixed 70px */}
          {!isCollapsed && (
            <div className="h-[70px] bg-white border-t border-[#E5E5E5] flex items-center justify-center px-4 gap-3 shrink-0 relative">
              {/* Scroll-to-bottom button above the input */}
              {!isAtBottom && (
                <div className="absolute -top-12 left-1/2 -translate-x-1/2 z-20">
                  <ScrollToBottomButton onClick={scrollToBottom} isAtBottom={isAtBottom} />
                </div>
              )}
              
              {/* Upload button */}
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImageUpload}
                  className="hidden"
                />
                <div className="p-2.5 bg-[#F1F3F5] hover:bg-[#ECE6F7] rounded-lg transition-colors">
                  <ImageIcon className="w-5 h-5 text-[#7A7A7A]" />
                </div>
              </label>
              
              {/* Input */}
              <Input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Type a message or upload product images..."
                className="flex-1 max-w-[500px] h-[40px] rounded-full border-[#E5E5E5] focus:border-[#D4C2F6] focus:ring-[#D4C2F6]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(inputValue);
                  }
                }}
                disabled={isLoading}
              />
              
              {/* Send button */}
              <Button
                size="icon"
                className="w-[40px] h-[40px] rounded-full shrink-0 bg-[#B999F3] hover:bg-[#D4C2F6] text-white"
                onClick={() => sendMessage(inputValue)}
                disabled={isLoading || !inputValue.trim()}
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}