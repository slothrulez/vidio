import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

const projectDomain =
  process.env.COZE_PROJECT_DOMAIN_DEFAULT || 'http://localhost:5000';

export const metadata: Metadata = {
  metadataBase: new URL(
    projectDomain.startsWith('http://') || projectDomain.startsWith('https://')
      ? projectDomain
      : `https://${projectDomain}`,
  ),
  title: {
    default: 'vidio | AI 商品视频创作',
    template: '%s | vidio',
  },
  description:
    '使用 vidio，将商品图片转化为带货短视频。通过对话识别商品卖点、创作文案、生成配音与视频片段，并合成完整成片。',
  keywords: [
    'vidio',
    'AI product video',
    '商品视频',
    '带货短视频',
    'AI 视频创作',
    '视频配音',
  ],
  applicationName: 'vidio',
  openGraph: {
    title: 'vidio | AI 商品视频创作',
    description:
      '使用 vidio，将商品图片转化为带货短视频。从商品卖点和文案到配音、视频片段与完整成片。',
    siteName: 'vidio',
    locale: 'zh_CN',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'vidio | AI 商品视频创作',
    description: '使用 vidio，从商品图片、卖点和文案创作完整的带货短视频。',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
