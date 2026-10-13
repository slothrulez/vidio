"use client";

import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Upload,
  Send,
  Video,
  FileText,
  Download,
  Loader2,
  Image as ImageIcon,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  Trash2,
} from "lucide-react";

// 消息类型
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  data?: Record<string, unknown>;
}

// 会话状态
interface SessionState {
  productImageUrl?: string;
  productName?: string;
  features?: string[];
  scripts?: Array<{ id: number; script: string; feature: string }>;
  segments?: Array<{
    id: number;
    script: string;
    feature: string;
    audioUrl: string;
    videoUrl: string;
    duration: number;
  }>;
  finalVideoUrl?: string;
  currentStage?: string;
}

export default function ChatAgentPage() {
  // 状态
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "您好！我是 vidio，专精于带货短视频生成。\n\n我可以帮您：\n1. 上传商品图片，自动识别商品和卖点\n2. 生成带货文案\n3. 生成带货视频片段\n4. 合成最终视频\n\n请上传您的商品图片，开始创作吧！",
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionState, setSessionState] = useState<SessionState>({});
  const [isLoading, setIsLoading] = useState(false);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | undefined>();
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);
  
  // 发送消息
  const sendMessage = async (content: string, imageUrl?: string) => {
    if (!content.trim() && !imageUrl) return;
    
    // 添加用户消息
    const userMessage: Message = {
      id: `user_${Date.now()}`,
      role: "user",
      content: imageUrl ? `${content}\n[已上传商品图片]` : content,
      timestamp: new Date(),
      data: imageUrl ? { imageUrl } : undefined,
    };
    setMessages(prev => [...prev, userMessage]);
    setInputValue("");
    setIsLoading(true);
    
    // 创建助手消息（流式）
    const assistantMessage: Message = {
      id: `assistant_${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    };
    setMessages(prev => [...prev, assistantMessage]);
    
    try {
      // 调用 Chat Agent API
      const response = await fetch("/api/chat-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: content,
          imageUrl,
          productName: sessionState.productName,
        }),
      });
      
      if (!response.ok) {
        throw new Error("请求失败");
      }
      
      // 处理 SSE 流
      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // 解析 SSE 数据
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const eventData = JSON.parse(line.slice(6));
              
              // 处理不同类型的事件
              switch (eventData.type) {
                case "text":
                  // 流式文本
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + eventData.content }
                        : m
                    )
                  );
                  break;
                
                case "tool_call":
                  // 工具调用通知
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + `\n🔧 正在调用工具...` }
                        : m
                    )
                  );
                  break;
                
                case "tool_result":
                  // 工具结果
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + `\n✅ ${eventData.content}` }
                        : m
                    )
                  );
                  break;
                
                case "state_update":
                  // 状态更新
                  setSessionId(eventData.sessionId);
                  setSessionState(eventData.state);
                  break;
                
                case "complete":
                  // 完成
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, isStreaming: false }
                        : m
                    )
                  );
                  break;
                
                case "error":
                  // 错误
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + `\n❌ 错误: ${eventData.content}`, isStreaming: false }
                        : m
                    )
                  );
                  break;
              }
            } catch {
              // 解析失败，忽略
            }
          }
        }
      }
      
      setIsLoading(false);
    } catch (error) {
      console.error("发送消息失败:", error);
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMessage.id
            ? { ...m, content: `抱歉，处理过程中出现了错误：${error instanceof Error ? error.message : "未知错误"}`, isStreaming: false }
            : m
        )
      );
      setIsLoading(false);
    }
  };
  
  // 上传图片
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // 上传到服务器
    const formData = new FormData();
    formData.append("file", file);
    
    try {
      const response = await fetch("/api/upload-image", {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) {
        throw new Error("上传失败");
      }
      
      const data = await response.json();
      setUploadedImageUrl(data.url);
      
      // 自动发送消息
      sendMessage("请帮我分析这张商品图片，识别商品信息并提取卖点", data.url);
    } catch (error) {
      console.error("上传图片失败:", error);
      alert("上传图片失败，请重试");
    }
  };
  
  // 清除会话
  const clearSession = async () => {
    if (sessionId) {
      await fetch(`/api/chat-agent?sessionId=${sessionId}`, { method: "DELETE" });
    }
    setSessionId(undefined);
    setSessionState({});
    setUploadedImageUrl(undefined);
    setMessages([
      {
        id: "welcome_new",
        role: "assistant",
        content: "会话已清除。请上传新的商品图片，开始新的创作！",
        timestamp: new Date(),
      },
    ]);
  };
  
  // 渲染消息内容
  const renderMessageContent = (message: Message) => {
    // 如果有视频片段数据，显示视频卡片
    if (message.data?.segments && sessionState.segments) {
      return (
        <div className="space-y-4">
          <p className="text-sm">{message.content}</p>
          <div className="grid grid-cols-2 gap-4">
            {sessionState.segments.map((segment, index) => (
              <Card key={`segment-${segment.id}-${index}`} className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline">片段 {segment.id}</Badge>
                  <span className="text-xs text-gray-500">{segment.duration}秒</span>
                </div>
                {segment.videoUrl ? (
                  <video
                    src={segment.videoUrl}
                    controls
                    className="w-full rounded-lg mb-2"
                  />
                ) : (
                  <div className="w-full aspect-video bg-gray-800 rounded-lg mb-2 flex items-center justify-center">
                    <p className="text-gray-400 text-sm">视频生成中...</p>
                  </div>
                )}
                <p className="text-xs text-gray-600">{segment.script}</p>
              </Card>
            ))}
          </div>
        </div>
      );
    }
    
    // 如果有最终视频，显示下载按钮
    if (message.data?.finalVideoUrl || sessionState.finalVideoUrl) {
      return (
        <div className="space-y-4">
          <p className="text-sm">{message.content}</p>
          <Card className="p-4">
            <video
              src={sessionState.finalVideoUrl}
              controls
              className="w-full rounded-lg mb-4"
            />
            <Button className="w-full" variant="default">
              <Download className="w-4 h-4 mr-2" />
              下载完整视频
            </Button>
          </Card>
        </div>
      );
    }
    
    // 普通文本消息
    return (
      <div className="text-sm whitespace-pre-wrap">{message.content}</div>
    );
  };
  
  // 当前阶段提示
  const getStageHint = () => {
    switch (sessionState.currentStage) {
      case "upload":
        return "已识别商品，可以确认信息后继续生成文案";
      case "scripts":
        return "已生成文案，可以修改后继续生成视频";
      case "segments":
        return "已生成视频片段，可以确认后合成最终视频";
      case "done":
        return "视频已完成，可以下载使用";
      default:
        return "请上传商品图片开始";
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <div className="max-w-4xl mx-auto p-4 py-8">
        {/* 标题 */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-2">
            <Sparkles className="w-8 h-8 text-purple-600" />
            vidio
          </h1>
          <p className="text-gray-500 mt-2">AI Agent 驱动的带货短视频生成工具</p>
        </div>
        
        {/* 状态卡片 */}
        {sessionState.productName && (
          <Card className="mb-4 p-4 bg-white/80 backdrop-blur">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                {sessionState.productImageUrl && (
                  <img
                    src={sessionState.productImageUrl}
                    alt={sessionState.productName}
                    className="w-16 h-16 object-cover rounded-lg"
                  />
                )}
                <div>
                  <h3 className="font-semibold">{sessionState.productName}</h3>
                  {sessionState.features && (
                    <div className="flex gap-2 mt-1">
                      {sessionState.features.slice(0, 3).map(f => (
                        <Badge key={f} variant="secondary" className="text-xs">
                          {f}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{getStageHint()}</Badge>
                <Button variant="ghost" size="sm" onClick={clearSession}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        )}
        
        {/* 对话区域 */}
        <Card className="bg-white/80 backdrop-blur mb-4">
          <ScrollArea className="h-[500px] p-4">
            <div ref={scrollRef} className="space-y-4">
              {messages.map(message => (
                <div
                  key={message.id}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-4 ${
                      message.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {message.role === "assistant" && message.isStreaming && (
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                    )}
                    {renderMessageContent(message)}
                    <div className="text-xs mt-2 opacity-60">
                      {message.timestamp.toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))}
              
              {/* 加载提示 */}
              {isLoading && messages[messages.length - 1]?.role === "user" && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-lg p-4">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                    正在思考...
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </Card>
        
        {/* 输入区域 */}
        <Card className="bg-white/80 backdrop-blur p-4">
          <div className="flex gap-4">
            {/* 图片上传 */}
            <div className="relative">
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <Button variant="outline" className="relative">
                <ImageIcon className="w-4 h-4 mr-2" />
                上传图片
              </Button>
            </div>
            
            {/* 文本输入 */}
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              placeholder="输入您的需求，例如：生成文案、合成视频..."
              className="flex-1"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(inputValue);
                }
              }}
            />
            
            {/* 发送按钮 */}
            <Button
              onClick={() => sendMessage(inputValue)}
              disabled={isLoading || (!inputValue.trim() && !uploadedImageUrl)}
              className="bg-gradient-to-r from-blue-600 to-purple-600"
            >
              <Send className="w-4 h-4 mr-2" />
              发送
            </Button>
          </div>
          
          {/* 快捷操作提示 */}
          <div className="flex gap-2 mt-4 text-sm text-gray-500">
            <span>快捷操作：</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendMessage("请生成带货文案")}
            >
              <FileText className="w-3 h-3 mr-1" />
              生成文案
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendMessage("请生成视频片段")}
            >
              <Video className="w-3 h-3 mr-1" />
              生成视频
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendMessage("请合成最终视频")}
            >
              <Sparkles className="w-3 h-3 mr-1" />
              合成视频
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}