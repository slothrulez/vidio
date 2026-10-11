import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert a local file path to a reachable URL
 * Development: /workspace/projects/public/xxx -> /xxx
 * Production: /tmp/xxx -> /api/file?path=/tmp/xxx
 * 
 * External provider video URLs go through the proxy API to bypass browser restrictions
 */
export function getAccessibleUrl(localPath: string, useProxy = true): string {
  if (!localPath) return '';
  
  // External provider video URLs use the proxy API
  if (useProxy && isExternalVideoUrl(localPath)) {
    return `/api/video-proxy?url=${encodeURIComponent(localPath)}`;
  }
  
  // Non-video http(s) URLs are returned as-is
  if (localPath.startsWith('http://') || localPath.startsWith('https://')) {
    return localPath;
  }
  
  // Production check
  const isProduction = typeof window !== 'undefined' && 
    !['localhost', '127.0.0.1'].includes(window.location.hostname);
  
  if (isProduction) {
    // Production: serve through the API proxy
    return `/api/file?path=${encodeURIComponent(localPath)}`;
  } else {
    // Development: absolute path to relative path
    // /workspace/projects/public/xxx -> /xxx
    const publicPrefix = '/workspace/projects/public';
    if (localPath.startsWith(publicPrefix)) {
      return localPath.replace(publicPrefix, '');
    }
    // Already relative
    if (localPath.startsWith('/')) {
      return localPath;
    }
    return localPath;
  }
}

/**
 * Whether an external video URL needs the proxy
 * Raw provider URLs usually contain tos-cn-beijing.volces.com or coze-dianbo
 * Signed object-storage URLs (coze-coding-project.tos) are reachable directly
 */
function isExternalVideoUrl(url: string): boolean {
  // Signed storage URLs need no proxy
  if (url.includes('coze-coding-project.tos.coze.site')) {
    return false;
  }
  
  // Raw provider URLs need the proxy (IP restricted)
  const videoHosts = [
    'tos-cn-beijing.volces.com',
    'tos-cn-shanghai.volces.com',
    'coze-dianbo.tos',
  ];
  
  return videoHosts.some(host => url.includes(host));
}
