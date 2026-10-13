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

// Message type
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  data?: Record<string, unknown>;
}

// Session state
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
  // State
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hi! I am vidio, your product video assistant.\n\nI can help you:\n1. Upload product images and identify the product and selling points\n2. Write the promotional script\n3. Generate product video clips\n4. Compose the final video\n\nUpload a product image to get started!",
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
  
  // Auto-scroll to the bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);
  
  // Send a message
  const sendMessage = async (content: string, imageUrl?: string) => {
    if (!content.trim() && !imageUrl) return;
    
    // Add the user message
    const userMessage: Message = {
      id: `user_${Date.now()}`,
      role: "user",
      content: imageUrl ? `${content}\n[Uploaded a product image]` : content,
      timestamp: new Date(),
      data: imageUrl ? { imageUrl } : undefined,
    };
    setMessages(prev => [...prev, userMessage]);
    setInputValue("");
    setIsLoading(true);
    
    // Create the streaming assistant message
    const assistantMessage: Message = {
      id: `assistant_${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    };
    setMessages(prev => [...prev, assistantMessage]);
    
    try {
      // Call the chat agent API
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
        throw new Error("Request failed");
      }
      
      // Handle the SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Could not read the response stream");
      
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Parse SSE data
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const eventData = JSON.parse(line.slice(6));
              
              // Handle each event type
              switch (eventData.type) {
                case "text":
                  // Streamed text
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + eventData.content }
                        : m
                    )
                  );
                  break;
                
                case "tool_call":
                  // Tool call notification
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + `\n🔧 Calling a tool...` }
                        : m
                    )
                  );
                  break;
                
                case "tool_result":
                  // Tool result
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + `\n✅ ${eventData.content}` }
                        : m
                    )
                  );
                  break;
                
                case "state_update":
                  // State update
                  setSessionId(eventData.sessionId);
                  setSessionState(eventData.state);
                  break;
                
                case "complete":
                  // Done
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, isStreaming: false }
                        : m
                    )
                  );
                  break;
                
                case "error":
                  // Error
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === assistantMessage.id
                        ? { ...m, content: m.content + `\n❌ Error: ${eventData.content}`, isStreaming: false }
                        : m
                    )
                  );
                  break;
              }
            } catch {
              // Ignore parse failures
            }
          }
        }
      }
      
      setIsLoading(false);
    } catch (error) {
      console.error("Failed to send message:", error);
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMessage.id
            ? { ...m, content: `Sorry, something went wrong: ${error instanceof Error ? error.message : "Unknown error"}`, isStreaming: false }
            : m
        )
      );
      setIsLoading(false);
    }
  };
  
  // Upload an image
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Upload to the server
    const formData = new FormData();
    formData.append("file", file);
    
    try {
      const response = await fetch("/api/upload-image", {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) {
        throw new Error("Upload failed");
      }
      
      const data = await response.json();
      setUploadedImageUrl(data.url);
      
      // Send the message automatically
      sendMessage("Please analyse this product image, identify the product and extract its selling points", data.url);
    } catch (error) {
      console.error("Image upload failed:", error);
      alert("Image upload failed, please try again");
    }
  };
  
  // Clear the session
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
        content: "Session cleared. Upload a new product image to start a new project!",
        timestamp: new Date(),
      },
    ]);
  };
  
  // Render message content
  const renderMessageContent = (message: Message) => {
    // Show video cards when segments exist
    if (message.data?.segments && sessionState.segments) {
      return (
        <div className="space-y-4">
          <p className="text-sm">{message.content}</p>
          <div className="grid grid-cols-2 gap-4">
            {sessionState.segments.map((segment, index) => (
              <Card key={`segment-${segment.id}-${index}`} className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline">Segment {segment.id}</Badge>
                  <span className="text-xs text-gray-500">{segment.duration}s</span>
                </div>
                {segment.videoUrl ? (
                  <video
                    src={segment.videoUrl}
                    controls
                    className="w-full rounded-lg mb-2"
                  />
                ) : (
                  <div className="w-full aspect-video bg-gray-800 rounded-lg mb-2 flex items-center justify-center">
                    <p className="text-gray-400 text-sm">Generating video...</p>
                  </div>
                )}
                <p className="text-xs text-gray-600">{segment.script}</p>
              </Card>
            ))}
          </div>
        </div>
      );
    }
    
    // Show the download button when the final video exists
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
              Download the full video
            </Button>
          </Card>
        </div>
      );
    }
    
    // Plain text message
    return (
      <div className="text-sm whitespace-pre-wrap">{message.content}</div>
    );
  };
  
  // Current stage hint
  const getStageHint = () => {
    switch (sessionState.currentStage) {
      case "upload":
        return "Product identified. Confirm the details, then write the script";
      case "scripts":
        return "Script ready. Edit it, then generate the video";
      case "segments":
        return "Video segments ready. Confirm them, then compose the final video";
      case "done":
        return "Your video is ready to download";
      default:
        return "Upload a product image to begin";
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <div className="max-w-4xl mx-auto p-4 py-8">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-800 flex items-center justify-center gap-2">
            <Sparkles className="w-8 h-8 text-purple-600" />
            vidio
          </h1>
          <p className="text-gray-500 mt-2">AI agent for short product videos</p>
        </div>
        
        {/* Status card */}
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
        
        {/* Conversation */}
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
              
              {/* Loading hint */}
              {isLoading && messages[messages.length - 1]?.role === "user" && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-lg p-4">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                    Thinking...
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </Card>
        
        {/* Input area */}
        <Card className="bg-white/80 backdrop-blur p-4">
          <div className="flex gap-4">
            {/* Image upload */}
            <div className="relative">
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <Button variant="outline" className="relative">
                <ImageIcon className="w-4 h-4 mr-2" />
                Upload image
              </Button>
            </div>
            
            {/* Text input */}
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              placeholder="Tell me what you need, e.g. write the script, compose the video..."
              className="flex-1"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(inputValue);
                }
              }}
            />
            
            {/* Send button */}
            <Button
              onClick={() => sendMessage(inputValue)}
              disabled={isLoading || (!inputValue.trim() && !uploadedImageUrl)}
              className="bg-gradient-to-r from-blue-600 to-purple-600"
            >
              <Send className="w-4 h-4 mr-2" />
              Send
            </Button>
          </div>
          
          {/* Quick actions */}
          <div className="flex gap-2 mt-4 text-sm text-gray-500">
            <span>Quick actions:</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendMessage("Write the promotional script")}
            >
              <FileText className="w-3 h-3 mr-1" />
              Write script
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendMessage("Generate the video segments")}
            >
              <Video className="w-3 h-3 mr-1" />
              Generate video
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendMessage("Compose the final video")}
            >
              <Sparkles className="w-3 h-3 mr-1" />
              Compose video
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}